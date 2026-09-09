function digitsOnly(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

export function normalizeWhatsAppNumber(value) {
  let number = digitsOnly(value).replace(/^00/, '');
  const countryCode = digitsOnly(process.env.DEFAULT_COUNTRY_CODE || '91');
  if (number.length === 10 && countryCode) number = `${countryCode}${number}`;
  return number;
}

function serviceConfig(account) {
  return {
    url: String(account?.serviceUrl || process.env.WHATSAPP_SERVICE_URL || '').replace(/\/$/, ''),
    token: account?.serviceToken || process.env.WHATSAPP_SERVICE_TOKEN || '',
    instanceId: account?.instanceId || process.env.WHATSAPP_INSTANCE_ID || '',
  };
}

export async function sendWhatsAppMessage(account, to, message) {
  const number = normalizeWhatsAppNumber(to);
  if (!number) throw new Error('Recipient phone number is invalid');

  const service = serviceConfig(account);
  if (service.url && service.token) {
    const response = await fetch(`${service.url}/send?access_token=${encodeURIComponent(service.token)}${service.instanceId ? `&instance_id=${encodeURIComponent(service.instanceId)}` : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: service.token, ...(service.instanceId ? { instance_id: service.instanceId } : {}), number, type: 'text', message: String(message) }),
    });
    const result = await response.json().catch(() => ({}));
    const providerStatus = String(result.status || '').toLowerCase();
    if (!response.ok || ['error', 'failed', 'provider_error', 'pending_credentials'].includes(providerStatus)) {
      throw new Error(result.message || result.error?.message || 'WhatsApp service rejected the message');
    }
    return { provider: 'whatsapp-service', number, ...result };
  }

  const token = account?.accessToken || process.env.META_ACCESS_TOKEN;
  const phoneNumberId = account?.phoneNumberId || process.env.META_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) throw new Error('WhatsApp provider credentials are not configured');

  const version = process.env.META_API_VERSION || 'v21.0';
  const response = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: number, type: 'text', text: { body: String(message) } }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || 'WhatsApp Cloud API rejected the message');
  return { provider: 'meta-cloud-api', number, ...result };
}
