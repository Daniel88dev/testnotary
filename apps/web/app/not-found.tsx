// Every "not found", including a private repo for someone GitHub does not show it to: the page
// never says whether such a repo exists.

export default function NotFound() {
  return (
    <main style={{ padding: "96px 24px", maxWidth: 560, margin: "0 auto", display: "grid", gap: 12 }}>
      <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>Not found</h1>
      <p style={{ margin: 0, color: "var(--muted)" }}>
        There is nothing here, or it is a private repo you cannot read on GitHub. Signing in may show it.
      </p>
      <p style={{ margin: 0 }}>
        <a href="/dashboard" style={{ color: "var(--skip)" }}>
          Your repositories
        </a>
      </p>
    </main>
  );
}
