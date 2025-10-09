import { NextRequest, NextResponse } from "next/server";

// Note: This endpoint no longer manages file-based cache
// The news API now uses in-memory caching which persists during warm starts

export async function DELETE(request: NextRequest) {
  return NextResponse.json({
    success: true,
    message:
      "Cache management has moved to in-memory storage. Cache is automatically managed per serverless instance and expires after 1 hour. Use /api/news?refresh=true to force a refresh.",
  });
}

export async function GET(request: NextRequest) {
  return NextResponse.json({
    info: "In-memory cache status is not available via API",
    message:
      "The news API now uses in-memory caching that persists during serverless function warm starts. Each instance maintains its own cache with 1-hour expiration.",
    usage: {
      refresh: "Use /api/news?refresh=true to bypass cache",
      country: "Use /api/news?country=us to get country-specific news",
    },
  });
}
