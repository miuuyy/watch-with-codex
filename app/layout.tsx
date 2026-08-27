import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Watch with GPT',
  description: 'Watch the same video together with GPT.',
  openGraph: {
    title: 'Watch with GPT',
    description: 'Watch something together.',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'Watch with GPT',
    description: 'Watch something together.',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="dark">
      <body>{children}</body>
    </html>
  );
}
