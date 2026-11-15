// A GitHub avatar, always through the app's own image route (`/api/avatars/<id>`), never from GitHub
// directly: the browser contacts only Testnotary. Use this for every person shown in the dashboard.

export function Avatar({ accountId, size = 22, className }: { accountId: number; size?: number; className?: string }) {
  return (
    <img
      className={`avatar${className ? ` ${className}` : ""}`}
      src={`/api/avatars/${accountId}`}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
    />
  );
}
