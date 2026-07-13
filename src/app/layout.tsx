import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SNAPFIX",
  description:
    "Detect home maintenance issues from photos and find grounded local contractors.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
