import Link from 'next/link';

export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: '80px auto', padding: 24 }}>
      <h1>TaskPilot</h1>
      <p>Your AI-powered todo list. Plan your day with an assistant that knows your tasks.</p>
      <Link href="/dashboard">Open dashboard →</Link>
    </main>
  );
}
