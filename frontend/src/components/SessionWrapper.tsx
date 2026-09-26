"use client";

import { SessionProvider } from "next-auth/react";

export default function SessionWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  // Re-reading the session every 5 minutes (and on tab focus, the default) lets NextAuth renew
  // Google's 1-hour tokens before they expire, so the admin panel never sends an expired one.
  return <SessionProvider refetchInterval={5 * 60}>{children}</SessionProvider>;
}
