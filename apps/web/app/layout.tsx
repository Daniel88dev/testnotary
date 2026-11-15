import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Testnotary",
  description: "Local test attestations that let CI skip a test job it can trust.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#070a12", color: "#e8edf9", fontFamily: "system-ui, sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
