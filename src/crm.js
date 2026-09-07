import express from 'express';
import { ObjectId } from 'mongodb';
import { adminRequired, authRequired } from './auth.js';
import { getDb } from './db.js';
import { sendQrMessage } from './whatsappSession.js';

const router = express.Router();
router.use(authRequired);

function id(value) {
  return ObjectId.isValid(value) ? new ObjectId(value) : null;
}

async function deliver(db, account, to, message) {
  if (account?.connectionType === 'qr') {
    return sendQrMessage(account._id, to, message);
  }

  const token = account?.accessToken || process.env.META_ACCESS_TOKEN;
  const phoneNumberId = account?.phoneNumberId || process.env.META_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) throw new Error('WhatsApp account credentials are not configured');
  const version = process.env.META_API_VERSION || 'v21.0';
  const response = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: message } }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || 'WhatsApp provider rejected the message');
  return result;
}

router.get('/stats', adminRequired, async (_req, res, next) => {
  try {
    const db = await getDb();
    const [unread, unresolved, solved, messages] = await Promise.all([
      db.collection('conversations').countDocuments({ unreadCount: { $gt: 0 } }),
      db.collection('conversations').countDocuments({ status: 'unresolved' }),
      db.collection('conversations').countDocuments({ status: 'solved' }),
      db.collection('conversation_messages').find({}).sort({ conversationId: 1, createdAt: 1 }).toArray(),
    ]);
    const lastInbound = new Map();
    const responseTimes = [];
    for (const message of messages) {
      const key = String(message.conversationId);
      if (message.direction === 'inbound') lastInbound.set(key, message.createdAt);
      if (message.direction === 'outbound' && lastInbound.has(key)) {
        responseTimes.push(new Date(message.createdAt) - new Date(lastInbound.get(key)));
        lastInbound.delete(key);
      }
    }
    const averageResponseMs = responseTimes.length ? Math.round(responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length) : 0;
    res.json({ unreadConversations: unread, unresolvedTickets: unresolved, solvedTickets: solved, averageResponseMs });
  } catch (error) { next(error); }
});

router.get('/conversations', adminRequired, async (req, res, next) => {
  try {
    const db = await getDb();
    const query = {};
    if (['unresolved', 'solved'].includes(req.query.status)) query.status = req.query.status;
    if (req.query.label) query.labels = String(req.query.label);
    const conversations = await db.collection('conversations').find(query).sort({ updatedAt: -1 }).limit(100).toArray();
    res.json({ conversations });
  } catch (error) { next(error); }
});

router.get('/conversations/:conversationId/messages', adminRequired, async (req, res, next) => {
  try {
    const conversationId = id(req.params.conversationId);
    if (!conversationId) return res.status(400).json({ error: 'Invalid conversation ID' });
    const db = await getDb();
    const messages = await db.collection('conversation_messages').find({ conversationId }).sort({ createdAt: 1 }).toArray();
    await db.collection('conversations').updateOne({ _id: conversationId }, { $set: { unreadCount: 0, updatedAt: new Date() } });
    res.json({ messages });
  } catch (error) { next(error); }
});

router.patch('/conversations/:conversationId', adminRequired, async (req, res, next) => {
  try {
    const conversationId = id(req.params.conversationId);
    if (!conversationId) return res.status(400).json({ error: 'Invalid conversation ID' });
    const updates = { updatedAt: new Date() };
    if (['unresolved', 'solved'].includes(req.body.status)) updates.status = req.body.status;
    if (Array.isArray(req.body.labels)) updates.labels = req.body.labels.map(String);
    if (req.body.assignedAgentId !== undefined) updates.assignedAgentId = String(req.body.assignedAgentId || '');
    const db = await getDb();
    await db.collection('conversations').updateOne({ _id: conversationId }, { $set: updates });
    res.json({ status: 'success' });
  } catch (error) { next(error); }
});

router.get('/labels', adminRequired, async (_req, res, next) => {
  try { res.json({ labels: await (await getDb()).collection('labels').find({}).sort({ name: 1 }).toArray() }); } catch (error) { next(error); }
});

router.post('/labels', adminRequired, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Label name is required' });
    const label = { name, color: req.body.color || '#25d366', createdAt: new Date() };
    const result = await (await getDb()).collection('labels').insertOne(label);
    res.status(201).json({ label: { ...label, _id: result.insertedId } });
  } catch (error) { next(error); }
});

router.delete('/labels/:labelId', adminRequired, async (req, res, next) => {
  try {
    const labelId = id(req.params.labelId);
    if (!labelId) return res.status(400).json({ error: 'Invalid label ID' });
    const db = await getDb();
    const label = await db.collection('labels').findOne({ _id: labelId });
    await db.collection('labels').deleteOne({ _id: labelId });
    if (label) await db.collection('conversations').updateMany({ labels: label.name }, { $pull: { labels: label.name } });
    res.json({ status: 'success' });
  } catch (error) { next(error); }
});

router.get('/faqs', adminRequired, async (_req, res, next) => {
  try { res.json({ faqs: await (await getDb()).collection('faqs').find({}).sort({ createdAt: -1 }).toArray() }); } catch (error) { next(error); }
});

router.post('/faqs', adminRequired, async (req, res, next) => {
  try {
    const question = String(req.body.question || '').trim();
    const answer = String(req.body.answer || '').trim();
    if (!question || !answer) return res.status(400).json({ error: 'Question and answer are required' });
    const faq = { question, answer, enabled: true, createdAt: new Date(), updatedAt: new Date() };
    const result = await (await getDb()).collection('faqs').insertOne(faq);
    res.status(201).json({ faq: { ...faq, _id: result.insertedId } });
  } catch (error) { next(error); }
});

router.delete('/faqs/:faqId', adminRequired, async (req, res, next) => {
  try {
    const faqId = id(req.params.faqId);
    if (!faqId) return res.status(400).json({ error: 'Invalid FAQ ID' });
    await (await getDb()).collection('faqs').deleteOne({ _id: faqId });
    res.json({ status: 'success' });
  } catch (error) { next(error); }
});

router.post('/bulk', async (req, res, next) => {
  try {
    const db = await getDb();
    const account = req.body.accountId && id(req.body.accountId)
      ? await db.collection('whatsapp_accounts').findOne({ _id: id(req.body.accountId) })
      : await db.collection('whatsapp_accounts').findOne({}, { sort: { createdAt: -1 } });
    const message = String(req.body.message || '').trim();
    const recipients = Array.isArray(req.body.recipients)
      ? req.body.recipients
      : String(req.body.recipients || '').split(/[\s,\n]+/).filter(Boolean);
    if (!message || !recipients.length) return res.status(400).json({ error: 'Recipients and message are required' });
    const campaign = { name: req.body.name || 'Bulk message', message, recipients, status: 'running', sent: 0, failed: 0, createdAt: new Date() };
    const campaignResult = await db.collection('campaigns').insertOne(campaign);
    for (const recipient of recipients) {
      try { await deliver(db, account, recipient, message); campaign.sent += 1; }
      catch { campaign.failed += 1; }
    }
    campaign.status = 'completed';
    await db.collection('campaigns').updateOne({ _id: campaignResult.insertedId }, { $set: { status: campaign.status, sent: campaign.sent, failed: campaign.failed, completedAt: new Date() } });
    res.json({ status: 'success', campaign: { ...campaign, _id: campaignResult.insertedId } });
  } catch (error) { next(error); }
});

router.get('/campaigns', async (_req, res, next) => {
  try {
    const campaigns = await (await getDb()).collection('campaigns').find({}).sort({ createdAt: -1 }).limit(100).toArray();
    res.json({ campaigns });
  } catch (error) { next(error); }
});

export default router;
