import type { Metadata } from "next";
import type { ReactNode } from "react";
import { mono, sans } from "./fonts.ts";
import "./tokens.css";

export const metadata: Metadata = {
  title: "Testnotary",
  description: "Local test attestations that let CI skip a test job it can trust.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
