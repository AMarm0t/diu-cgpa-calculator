import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DIU CGPA Calculator",
  description: "Daffodil International University CGPA Calculator",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
