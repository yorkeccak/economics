import { NextRequest } from "next/server";
import { Valyu } from "valyu-js";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const country = searchParams.get("country") || "global";

    const valyuApiKey = process.env.VALYU_API_KEY;
    if (!valyuApiKey) {
      return new Response("Valyu API key not configured", { status: 500 });
    }

    const valyu = new Valyu(valyuApiKey, "https://api.valyu.network/v1");

    // Generate country-specific news queries using template
    const getCountryQueries = (country: string) => {
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

      const queryTemplates = [
        "{country} economics news",
        "{country} economy news",
        "{country} economic policy news",
        "{country} economic indicators news",
        "{country} economic markets news",
        "{country} central bank news",
        "{country} financial news",
        "{country} business news",
        "{country} economic growth news",
        "{country} inflation news",
      ];

      return queryTemplates.map((template) =>
        template.replace("{country}", countryName)
      );
    };

    const newsQueries = getCountryQueries(country);
    const maxResults = 30;
    let allResults: any[] = [];
    let completedQueries = 0;
    const totalQueries = newsQueries.length;

    // Create a readable stream
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        // Send initial message
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "start",
              total: totalQueries,
            })}\n\n`
          )
        );

        // Create promises for all queries
        const queryPromises = newsQueries.map(async (query, index) => {
          try {
            console.log(`[News API] Searching for: ${query}`);

            // Search without options - this avoids 403 errors
            const response = await valyu.search(query);
            console.log(`[News API] Response for "${query}":`, {
              resultsCount: response?.results?.length || 0,
              firstResult: response?.results?.[0]?.title || "none",
            });

            return {
              results: response?.results || [],
              queryIndex: index,
              query: query,
            };
          } catch (queryError) {
            console.error(
              `[News API] Error with query "${query}":`,
              queryError
            );
            return {
              results: [],
              queryIndex: index,
              query: query,
            };
          }
        });

        // Process results as they complete
        for (const promise of queryPromises) {
          const result = await promise;
          completedQueries++;

          console.log(
            `[News API] Processing query ${completedQueries}/${totalQueries}: ${result.results.length} results`
          );

          if (result.results.length > 0) {
            allResults = [...allResults, ...result.results];
            console.log(
              `[News API] Total accumulated results: ${allResults.length}`
            );

            // Process and send results immediately
            const processedResults = result.results
              .map((item: any) => ({
                title: item.title || "News Article",
                url: item.url,
                image_url: item.image_url || null,
                content: item.content || "",
                source: item.metadata?.source || "News Source",
                date: item.metadata?.date || new Date().toISOString(),
              }))
              .filter((item: any) => {
                // Filter out banned sources
                return (
                  !item.url.toLowerCase().includes("politico") &&
                  !item.source.toLowerCase().includes("politico") &&
                  !item.title.toLowerCase().includes("politico") &&
                  !item.url.toLowerCase().includes("usatoday") &&
                  !item.source.toLowerCase().includes("usatoday") &&
                  !item.title.toLowerCase().includes("usatoday") &&
                  !item.url.toLowerCase().includes("wikipedia") &&
                  !item.source.toLowerCase().includes("wikipedia") &&
                  !item.title.toLowerCase().includes("wikipedia") &&
                  !item.url.toLowerCase().includes("investing.com") &&
                  !item.source.toLowerCase().includes("investing.com")
                );
              });

            // Send new results
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "results",
                  results: processedResults,
                  total: allResults.length,
                  completed: completedQueries,
                  query: result.query,
                })}\n\n`
              )
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

        // Send completion message
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "complete",
              total: allResults.length,
              completed: completedQueries,
            })}\n\n`
          )
        );

        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("Error in news stream API:", error);
    return new Response("Internal server error", { status: 500 });
  }
}
