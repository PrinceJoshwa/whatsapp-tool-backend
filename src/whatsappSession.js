import 'dotenv/config';
import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { getDb } from './db.js';

const sessions = new Map();
const runningOnVercel = process.env.VERCEL === '1' || process.env.VERCEL === 'true';
const sessionsRoot = process.env.WHATSAPP_SESSIONS_DIR
  ? path.resolve(process.env.WHATSAPP_SESSIONS_DIR)
  : (runningOnVercel ? '/tmp/whatsapp-sessions' : path.resolve('data/sessions'));

function authPath(accountId) {
  return path.join(sessionsRoot, String(accountId));
}

function phoneJid(value) {
  const phone = String(value || '').replace(/[^0-9]/g, '');
  return phone ? `${phone}@s.whatsapp.net` : '';
}

async function updateAccount(accountId, values) {
  const db = await getDb();
  await db.collection('whatsapp_accounts').updateOne(
    { _id: accountId },
    { $set: { ...values, updatedAt: new Date() } },
  );
}

function publicState(entry) {
  return {
    status: entry?.status || 'disconnected',
    qr: entry?.qr || null,
    phone: entry?.phone || null,
    error: entry?.error || null,
  };
}

export async function startQrSession(accountId) {
  if (runningOnVercel) {
    const error = new Error('QR WhatsApp connections require an always-on Node backend with persistent storage. Deploy the QR backend on Railway, Render, Fly.io, or a VPS; use Vercel for the React frontend and Cloud API.');
    error.statusCode = 503;
    error.code = 'QR_RUNTIME_REQUIRED';
    throw error;
  }

  const key = String(accountId);
  const existing = sessions.get(key);
  if (existing) return publicState(existing);

  await mkdir(sessionsRoot, { recursive: true });
  const entry = { status: 'starting', qr: null, phone: null, error: null };
  sessions.set(key, entry);
  const { state, saveCreds } = await useMultiFileAuthState(authPath(accountId));
  let version = [2, 3000, 1017531287];
  try {
    const latest = await fetchLatestBaileysVersion();
    if (latest?.version) version = latest.version;
  } catch (error) {
    console.warn('Could not fetch the latest WhatsApp Web version:', error.message);
  }

  const socket = makeWASocket({
    version,
    auth: state,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    printQRInTerminal: false,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 45_000,
    keepAliveIntervalMs: 30_000,
    markOnlineOnConnect: false,
  });
  entry.socket = socket;

  socket.ev.on('creds.update', saveCreds);
  socket.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const db = await getDb();
      for (const message of messages || []) {
        if (message.key?.fromMe) continue;
        const remoteJid = message.key?.remoteJid || '';
        if (!remoteJid.endsWith('@s.whatsapp.net')) continue;
        const phone = remoteJid.split('@')[0];
        const content = message.message?.conversation
          || message.message?.extendedTextMessage?.text
          || '[Media message]';
        const now = new Date();
        let conversation = await db.collection('conversations').findOne({ accountId, phone });
        if (!conversation) {
          const result = await db.collection('conversations').insertOne({
            accountId,
            phone,
            contactName: message.pushName || phone,
            status: 'unresolved',
            unreadCount: 1,
            labels: [],
            lastMessagePreview: content,
            createdAt: now,
            updatedAt: now,
          });
          conversation = { _id: result.insertedId };
        } else {
          await db.collection('conversations').updateOne(
            { _id: conversation._id },
            { $set: { lastMessagePreview: content, updatedAt: now }, $inc: { unreadCount: 1 } },
          );
        }
        await db.collection('conversation_messages').insertOne({
          conversationId: conversation._id,
          accountId,
          phone,
          direction: 'inbound',
          senderType: 'contact',
          content,
          createdAt: now,
        });
      }
    } catch (error) {
      console.error('Could not persist incoming WhatsApp message:', error.message);
    }
  });
  socket.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    try {
      if (qr) {
        entry.status = 'qr';
        entry.qr = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
        entry.error = null;
        await updateAccount(accountId, { status: 'qr', connectionType: 'qr' });
      }

      if (connection === 'open') {
        entry.status = 'connected';
        entry.qr = null;
        entry.error = null;
        entry.phone = socket.user?.id?.split(':')[0] || null;
        await updateAccount(accountId, {
          status: 'connected',
          connectionType: 'qr',
          phone: entry.phone || '',
        });
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        sessions.delete(key);
        entry.socket = null;
        entry.qr = null;
        entry.status = 'disconnected';
        entry.error = loggedOut ? 'WhatsApp session logged out' : 'WhatsApp connection closed';
        await updateAccount(accountId, { status: 'disconnected', connectionType: 'qr' });

        if (loggedOut && existsSync(authPath(accountId))) {
          await rm(authPath(accountId), { recursive: true, force: true });
        }

        if (!loggedOut) {
          setTimeout(() => {
            startQrSession(accountId).catch((error) => console.error('QR reconnect failed:', error.message));
          }, 2000);
        }
      }
    } catch (error) {
      entry.status = 'error';
      entry.error = error.message;
    }
  });

  return publicState(entry);
}

export async function getQrSession(accountId) {
  return publicState(sessions.get(String(accountId)));
}

export async function sendQrMessage(accountId, to, message) {
  const entry = sessions.get(String(accountId));
  if (!entry?.socket || entry.status !== 'connected') {
    throw new Error('This WhatsApp account is not connected by QR');
  }
  const jid = phoneJid(to);
  if (!jid) throw new Error('Recipient phone is required');
  return entry.socket.sendMessage(jid, { text: String(message) });
}

export async function logoutQrSession(accountId) {
  const key = String(accountId);
  const entry = sessions.get(key);
  if (entry?.socket) {
    try { await entry.socket.logout(); } catch {}
  }
  sessions.delete(key);
  await rm(authPath(accountId), { recursive: true, force: true });
  await updateAccount(accountId, { status: 'disconnected', connectionType: 'qr' });
}
