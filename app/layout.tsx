import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PauaRipple',
  description: 'Browser-based voice dictation powered by Aqua Voice Avalon API',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
