import { NextRequest, NextResponse } from "next/server";
import { Valyu } from "valyu-js";

// In-memory cache (persists during warm starts)
let memoryCache: {
  [country: string]: {
    newsItems: any[];
    timestamp: number;
  };
} = {};

// Separate function to fetch news data
async function fetchNewsData(country: string) {
  const valyuApiKey = process.env.VALYU_API_KEY;

  if (!valyuApiKey) {
    throw new Error("Valyu API key not configured");
  }

  const valyu = new Valyu(valyuApiKey, "https://api.valyu.network/v1");

  // Generate country-specific news queries using template
  const getCountryQueries = (country: string) => {
    // Country name mapping for better search results
    const countryNames = {
      global: "global international",
      us: "United States US America",
      uk: "United Kingdom UK Britain British",
      germany: "Germany German",
      france: "France French",
      japan: "Japan Japanese",
      china: "China Chinese",
      india: "India Indian",
      canada: "Canada Canadian",
      australia: "Australia Australian",
      singapore: "Singapore Singapore",
      mexico: "Mexico Mexican",
      "south-korea": "South Korea Korean",
      italy: "Italy Italian",
      spain: "Spain Spanish",
      russia: "Russia Russian",
    };

    const countryName =
      countryNames[country as keyof typeof countryNames] || country;

    // Base query templates with {country} placeholder
    const queryTemplates = [
      "{country} economics news today",
      "{country} economic policy news today",
      "{country} economic indicators news today",
      "{country} economic markets news today",
      "{country} economic development news today",
      "{country} central bank news today",
      "{country} economic growth news today",
      "{country} inflation news today",
      "{country} employment news today",
      "{country} trade news today",
      "{country} economic outlook news today",
    ];

    // Replace {country} placeholder with actual country names
    return queryTemplates.map((template) =>
      template.replace("{country}", countryName)
    );
  };

  const newsQueries = getCountryQueries(country);

  console.log(`Running news queries for country: ${country}...`);

  // Run queries in parallel with early termination
  const maxResults = 30; // Stop when we have 30 distinct results
  let allResults: any[] = [];
  let completedQueries = 0;
  const totalQueries = newsQueries.length;

  // Create a promise for each query
  const queryPromises = newsQueries.map(async (query, index) => {
    try {
      console.log(`Searching for: ${query}`);
      const response = await valyu.search(query);
      console.log(
        `Response for "${query}":`,
        response?.results?.length || 0,
        "results"
      );
      return {
        results: response?.results || [],
        queryIndex: index,
        query: query,
      };
    } catch (queryError) {
      console.error(`Error with query "${query}":`, queryError);
      return {
        results: [],
        queryIndex: index,
        query: query,
      };
    }
  });

  // Process results as they complete, stopping when we have enough
  for (const promise of queryPromises) {
    const result = await promise;
    completedQueries++;

    if (result.results.length > 0) {
      allResults = [...allResults, ...result.results];
      console.log(
        `Added ${result.results.length} results from "${result.query}", total: ${allResults.length}`
      );
    }

    // Stop if we have enough results
    if (allResults.length >= maxResults) {
      console.log(
        `Stopping queries early - already have ${allResults.length} results (completed ${completedQueries}/${totalQueries} queries)`
      );
      break;
    }
  }

  console.log(`Total results collected: ${allResults.length}`);

  if (allResults.length === 0) {
    throw new Error("No news articles found");
  }

  // Map results and remove duplicates
  const newsItems = allResults
    .map((item: any) => ({
      title: item.title || "News Article",
      url: item.url,
      image_url: item.image_url || null,
      content: item.content || "",
      source: item.metadata?.source || "News Source",
      date: item.metadata?.date || new Date().toISOString(),
    }))
    // Remove duplicates based on URL
    .filter(
      (item, index, self) =>
        index === self.findIndex((t) => t.url === item.url)
    )
    // Remove duplicates based on title
    .filter(
      (item, index, self) =>
        index === self.findIndex((t) => t.title === item.title)
    )
    // Ban Politico, USA Today, and Wikipedia sources
    .filter(
      (item) =>
        !item.url.toLowerCase().includes("politico") &&
        !item.source.toLowerCase().includes("politico") &&
        !item.title.toLowerCase().includes("politico") &&
        !item.url.toLowerCase().includes("usatoday") &&
        !item.source.toLowerCase().includes("usatoday") &&
        !item.title.toLowerCase().includes("usatoday") &&
        !item.url.toLowerCase().includes("wikipedia") &&
        !item.source.toLowerCase().includes("wikipedia") &&
        !item.title.toLowerCase().includes("wikipedia")
    )
    // Limit to 15 articles for performance
    .slice(0, 15);

  console.log(`Final news items: ${newsItems.length}`);

  return newsItems;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const refresh = searchParams.get("refresh") === "true";
    const country = searchParams.get("country") || "global";

    // Check in-memory cache first
    const cached = memoryCache[country];
    const oneHour = 60 * 60 * 1000; // 1 hour in milliseconds

    if (cached && !refresh) {
      const cacheAge = Date.now() - cached.timestamp;

      if (cacheAge < oneHour) {
        console.log(
          `Returning cached news for ${country} (age: ${Math.floor(cacheAge / 1000 / 60)}m)`
        );
        return NextResponse.json({
          newsItems: cached.newsItems,
          total: cached.newsItems.length,
          cached: true,
        });
      }
    }

    // Fetch fresh news data
    try {
      console.log(`Fetching fresh news for ${country}...`);
      const newsItems = await fetchNewsData(country);

      // Update in-memory cache
      memoryCache[country] = {
        newsItems,
        timestamp: Date.now(),
      };

      return NextResponse.json({
        newsItems: newsItems,
        total: newsItems.length,
        cached: false,
      });
    } catch (fetchError) {
      console.error("Error fetching news:", fetchError);

      // If fetch fails but we have stale cache, return it
      if (cached) {
        console.log(
          `Fetch failed, returning stale cache for ${country} (age: ${Math.floor((Date.now() - cached.timestamp) / 1000 / 60)}m)`
        );
        return NextResponse.json({
          newsItems: cached.newsItems,
          total: cached.newsItems.length,
          cached: true,
          stale: true,
        });
      }

      // No cache available, return error
      return NextResponse.json(
        {
          error:
            fetchError instanceof Error
              ? fetchError.message
              : "Failed to fetch news",
          newsItems: [],
          total: 0,
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("Error in news API:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
