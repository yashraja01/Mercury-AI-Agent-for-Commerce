import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Sans_Devanagari } from "next/font/google";
import "./globals.css";

/*
 * IBM Plex throughout, for one reason: it is the only widely available family
 * that carries a Devanagari companion with the same skeleton as its Latin. Dwaar
 * (द्वार) and Sakshi (साक्षी) can be set in their own script beside their Latin
 * names without a second typeface fighting the first.
 *
 * Mono is the display face, not the utility face. This is an instrument that
 * reads amounts in paise; the type should look like it was made to hold digits.
 */

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-sans",
  display: "swap",
});

const devanagari = IBM_Plex_Sans_Devanagari({
  subsets: ["devanagari"],
  weight: ["400", "600"],
  variable: "--font-plex-deva",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Mercury Mission Control",
  description:
    "Two AI agents negotiate. A deterministic gate decides whether a single rupee may move.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${mono.variable} ${sans.variable} ${devanagari.variable}`}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
