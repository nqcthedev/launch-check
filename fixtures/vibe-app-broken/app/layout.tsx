import './globals.css';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <title>TaskPilot</title>
      </head>
      <body>{children}</body>
    </html>
  );
}
