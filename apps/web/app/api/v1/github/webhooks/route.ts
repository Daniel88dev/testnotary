import { applyWebhook, signatureMatches, WebhookPayloadError, webhookSecret } from "../../../../../src/server/github-webhooks.ts";

export const dynamic = "force-dynamic";

/** The GitHub App's webhook URL. The signature is checked on the raw body before it is parsed. */
export async function POST(request: Request): Promise<Response> {
  const secret = webhookSecret();
  if (!secret) return Response.json({ error: "not_configured" }, { status: 503 });
  const body = await request.text();
  if (!signatureMatches(secret, body, request.headers.get("x-hub-signature-256"))) {
    return Response.json({ error: "bad_signature" }, { status: 401 });
  }
  const event = request.headers.get("x-github-event");
  const deliveryId = request.headers.get("x-github-delivery");
  if (!event || !deliveryId) return Response.json({ error: "bad_request" }, { status: 400 });
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  try {
    return Response.json(await applyWebhook(event, deliveryId, payload));
  } catch (error) {
    if (error instanceof WebhookPayloadError) return Response.json({ error: "bad_request", message: error.message }, { status: 400 });
    throw error;
  }
}
