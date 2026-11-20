import Link from 'next/link';

export default function NotFound() {
  return (
    <main style={{ maxWidth: 720, margin: '80px auto', padding: 24 }}>
      <h1>Page not found</h1>
      <p>That page does not exist or has moved.</p>
      <Link href="/">Back to TaskPilot</Link>
    </main>
  );
}
