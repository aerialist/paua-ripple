import type { Metadata } from 'next';
import Script from 'next/script';
import './globals.css';

export const metadata: Metadata = {
  title: 'PauaRipple',
  description: 'Browser-based voice dictation powered by Aqua Voice Avalon API',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Script
          defer
          src="https://analytics.shunpy.net/script.js"
          data-website-id="78827da5-234e-425c-b8a4-e8b68593f9d4"
        />
        {children}
      </body>
    </html>
  );
}
