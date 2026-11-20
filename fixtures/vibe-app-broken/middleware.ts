import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Protect the dashboard: only logged-in users can see it
export function middleware(req: NextRequest) {
  const session = req.cookies.get('sb-access-token');
  if (!session) {
    return NextResponse.redirect(new URL('/login', req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*'],
};
