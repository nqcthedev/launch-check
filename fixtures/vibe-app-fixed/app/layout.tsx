import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  title: { default: 'TaskPilot: your AI-powered todo list', template: '%s · TaskPilot' },
  description: 'Plan your day with an assistant that knows your tasks.',
  openGraph: {
    title: 'TaskPilot',
    description: 'Plan your day with an assistant that knows your tasks.',
    type: 'website',
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
