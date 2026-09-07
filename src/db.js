import { MongoClient } from 'mongodb';

let clientPromise;

export async function getDb() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is not configured');
  }

  if (!clientPromise) {
    clientPromise = new MongoClient(process.env.MONGODB_URI).connect();
  }

  const client = await clientPromise;
  return client.db(process.env.MONGODB_DB || 'new_whatsapp_tool');
}
