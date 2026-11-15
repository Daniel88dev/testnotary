import { fetchAvatar } from "../../../../src/server/github.ts";

// GitHub avatars through Testnotary, so a browser on the dashboard contacts no one else. Keyed by
// the account's numeric GitHub id; any GitHub account's avatar is public on GitHub anyway.

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!/^\d{1,15}$/.test(id)) return new Response(null, { status: 404 });
  const avatar = await fetchAvatar(Number(id));
  if (!avatar) return new Response(null, { status: 404, headers: { "cache-control": "public, max-age=60" } });
  return new Response(avatar.body, {
    status: 200,
    headers: {
      "content-type": avatar.contentType,
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
    },
  });
}
