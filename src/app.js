import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { ObjectId } from 'mongodb';
import { adminRequired, authRequired, signUser } from './auth.js';
import { getDb } from './db.js';
import { getQrSession, logoutQrSession, sendQrMessage, startQrSession } from './whatsappSession.js';
import crmRouter from './crm.js';
import { sendWhatsAppMessage } from './whatsappProvider.js';

const app = express();

async function recordOutbound(db, account, to, message, providerResult) {
  const phone = String(to).replace(/[^0-9]/g, '');
  const now = new Date();
  const filter = { accountId: account?._id || null, phone };
  let conversation = await db.collection('conversations').findOne(filter);
  if (!conversation) {
    const result = await db.collection('conversations').insertOne({
      ...filter,
      contactName: phone,
      status: 'unresolved',
      unreadCount: 0,
      labels: [],
      lastMessagePreview: message,
      createdAt: now,
      updatedAt: now,
    });
    conversation = { _id: result.insertedId };
  } else {
    await db.collection('conversations').updateOne({ _id: conversation._id }, { $set: { lastMessagePreview: message, updatedAt: now } });
  }
  await db.collection('conversation_messages').insertOne({ conversationId: conversation._id, accountId: account?._id || null, phone, direction: 'outbound', senderType: 'agent', content: message, providerResult, createdAt: now });
}

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));
app.use('/api/crm', crmRouter);

app.get('/', (_req, res) => {
  res.json({ status: 'success', message: 'WhatsApp Tool API is running' });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const expectedEmail = process.env.APP_LOGIN_EMAIL || 'admin@whatsapp.local';
  const expectedPassword = process.env.APP_LOGIN_PASSWORD || 'WhatsApp@2026!';

  if (email !== expectedEmail || password !== expectedPassword) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const user = { email: expectedEmail, name: 'WhatsApp Admin', role: process.env.APP_LOGIN_ROLE || 'admin' };
  res.json({ user, token: signUser(user) });
});

app.get('/api/auth/me', authRequired, (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/whatsapp/summary', authRequired, async (_req, res, next) => {
  try {
    const db = await getDb();
    const [accounts, contacts, campaigns, templates, messages] = await Promise.all([
      db.collection('whatsapp_accounts').countDocuments(),
      db.collection('contacts').countDocuments(),
      db.collection('campaigns').countDocuments(),
      db.collection('templates').countDocuments(),
      db.collection('messages').countDocuments(),
    ]);
    res.json({ mode: 'cloud-api', accounts, contacts, campaigns, templates, messages });
  } catch (error) {
    next(error);
  }
});

app.get('/api/whatsapp/accounts', authRequired, async (_req, res, next) => {
  try {
    const db = await getDb();
    const accounts = await db.collection('whatsapp_accounts').find({}, { projection: { accessToken: 0 } }).sort({ createdAt: -1 }).toArray();
    res.json({ accounts });
  } catch (error) {
    next(error);
  }
});

app.post('/api/whatsapp/accounts', authRequired, async (req, res, next) => {
  try {
    const db = await getDb();
    const now = new Date();
    const account = {
      name: req.body.name || 'WhatsApp Account',
      phoneNumberId: req.body.phoneNumberId || '',
      wabaId: req.body.wabaId || '',
      businessName: req.body.businessName || '',
      accessToken: req.body.accessToken || '',
      connectionType: req.body.connectionType === 'qr' ? 'qr' : 'cloud',
      status: req.body.connectionType === 'qr' ? 'disconnected' : 'connected',
      createdAt: now,
      updatedAt: now,
    };
    const result = await db.collection('whatsapp_accounts').insertOne(account);
    res.status(201).json({ account: { ...account, _id: result.insertedId, accessToken: undefined } });
  } catch (error) {
    next(error);
  }
});

app.post('/api/whatsapp/accounts/:accountId/qr', authRequired, async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.accountId)) return res.status(400).json({ error: 'Invalid account ID' });
    const db = await getDb();
    const accountId = new ObjectId(req.params.accountId);
    const account = await db.collection('whatsapp_accounts').findOne({ _id: accountId });
    if (!account) return res.status(404).json({ error: 'WhatsApp account not found' });
    res.json(await startQrSession(accountId));
  } catch (error) {
    next(error);
  }
});

app.get('/api/whatsapp/accounts/:accountId/qr', authRequired, async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.accountId)) return res.status(400).json({ error: 'Invalid account ID' });
    res.json(await getQrSession(new ObjectId(req.params.accountId)));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/whatsapp/accounts/:accountId/qr', authRequired, async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.accountId)) return res.status(400).json({ error: 'Invalid account ID' });
    await logoutQrSession(new ObjectId(req.params.accountId));
    res.json({ status: 'success' });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/whatsapp/accounts/:accountId', authRequired, async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.accountId)) return res.status(400).json({ error: 'Invalid account ID' });
    const db = await getDb();
    const accountId = new ObjectId(req.params.accountId);
    const account = await db.collection('whatsapp_accounts').findOne({ _id: accountId });
    if (!account) return res.status(404).json({ error: 'WhatsApp account not found' });
    if (account.connectionType === 'qr') {
      await logoutQrSession(accountId);
    }
    await db.collection('whatsapp_accounts').deleteOne({ _id: accountId });
    res.json({ status: 'success' });
  } catch (error) {
    next(error);
  }
});

app.get('/api/whatsapp/contacts', authRequired, async (_req, res, next) => {
  try {
    const db = await getDb();
    const contacts = await db.collection('contacts').find({}).sort({ createdAt: -1 }).limit(100).toArray();
    res.json({ contacts });
  } catch (error) {
    next(error);
  }
});

app.post('/api/whatsapp/contacts', authRequired, async (req, res, next) => {
  try {
    const phone = String(req.body.phone || '').replace(/[^0-9]/g, '');
    if (!phone) return res.status(400).json({ error: 'Phone is required' });

    const db = await getDb();
    const contact = { name: req.body.name || phone, phone, tags: req.body.tags || [], createdAt: new Date() };
    const result = await db.collection('contacts').insertOne(contact);
    res.status(201).json({ contact: { ...contact, _id: result.insertedId } });
  } catch (error) {
    next(error);
  }
});

app.post('/api/whatsapp/send', authRequired, async (req, res, next) => {
  try {
    const { to, message, accountId } = req.body || {};
    if (!to || !message) return res.status(400).json({ error: 'Recipient and message are required' });

    const db = await getDb();
    const account = accountId
      ? await db.collection('whatsapp_accounts').findOne({ _id: new ObjectId(accountId) })
      : await db.collection('whatsapp_accounts').findOne({}, { sort: { createdAt: -1 } });

    if (account?.connectionType === 'qr') {
      const providerResult = await sendQrMessage(account._id, to, message);
      await db.collection('messages').insertOne({ accountId: account._id, to, message, providerResult, status: 'sent', createdAt: new Date() });
      await recordOutbound(db, account, to, message, providerResult);
      return res.json({ status: 'success', result: providerResult });
    }

    const providerResult = await sendWhatsAppMessage(account, to, message);
    await db.collection('messages').insertOne({ to, message, providerResult, status: 'accepted', createdAt: new Date() });
    await recordOutbound(db, account, to, message, providerResult);
    res.json({ status: 'success', result: providerResult });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.statusCode || 500).json({ error: error.message || 'Server error', code: error.code });
});

export default app;

