"use client";
import { useState, useEffect } from "react";
import Image from "next/image";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface NewsItem {
  title: string;
  url: string;
  image_url?: string | Record<string, string>;
  content: string;
  source: string;
  date?: string;
}

export function LatestNews() {
  const [newsItems, setNewsItems] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [selectedCountry, setSelectedCountry] = useState("global");

  const countries = [
    { value: "global", label: "🌍 Global" },
    { value: "us", label: "🇺🇸 United States" },
    { value: "uk", label: "🇬🇧 United Kingdom" },
    { value: "germany", label: "🇩🇪 Germany" },
    { value: "france", label: "🇫🇷 France" },
    { value: "japan", label: "🇯🇵 Japan" },
    { value: "china", label: "🇨🇳 China" },
    { value: "india", label: "🇮🇳 India" },
    { value: "canada", label: "🇨🇦 Canada" },
    { value: "australia", label: "🇦🇺 Australia" },
    { value: "singapore", label: "🇸🇬 Singapore" },
    { value: "mexico", label: "🇲🇽 Mexico" },
    { value: "south-korea", label: "🇰🇷 South Korea" },
    { value: "italy", label: "🇮🇹 Italy" },
    { value: "spain", label: "🇪🇸 Spain" },
    { value: "russia", label: "🇷🇺 Russia" },
  ];

  // Function to generate images with their corresponding news URLs
  const generateImagesWithUrls = (
    newsData: NewsItem[]
  ): { image: string; url: string }[] => {
    const imageUrlPairs: { image: string; url: string }[] = [];

    newsData.forEach((item) => {
      // Ban investing.com sources
      if (
        item.source?.toLowerCase().includes("investing.com") ||
        item.url?.toLowerCase().includes("investing.com")
      ) {
        return;
      }

      const imageUrl = item.image_url;
      if (typeof imageUrl === "string") {
        imageUrlPairs.push({ image: imageUrl, url: item.url });
      } else if (typeof imageUrl === "object" && imageUrl !== null) {
        // Handle object format like {"0": "https://...", "1": "https://..."}
        const values = Object.values(imageUrl);
        values.forEach((val) => {
          if (typeof val === "string" && val.startsWith("http")) {
            imageUrlPairs.push({ image: val, url: item.url });
          }
        });
      }
    });

    console.log(
      `Extracted ${imageUrlPairs.length} image-URL pairs from ${newsData.length} news articles`
    );
    return imageUrlPairs;
  };

  useEffect(() => {
    const fetchLatestNews = async () => {
      try {
        setLoading(true);
        setError(null);

        // Use streaming endpoint for progressive loading
        const response = await fetch(
          `/api/news/stream?country=${selectedCountry}`
        );

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let accumulatedResults: NewsItem[] = [];

        if (reader) {
          while (true) {
            const { done, value } = await reader.read();

            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                try {
                  const data = JSON.parse(line.slice(6));

                  if (data.type === "results") {
                    // Add new results immediately
                    const newResults = data.results || [];
                    accumulatedResults = [...accumulatedResults, ...newResults];

                    // Update UI immediately with new results
                    setNewsItems(accumulatedResults);
                    console.log(
                      `Added ${newResults.length} results, total: ${accumulatedResults.length}`
                    );
                  } else if (data.type === "complete") {
                    console.log(
                      `Completed fetching news for ${selectedCountry}: ${data.total} total results`
                    );
                    setNewsItems(accumulatedResults);
                  }
                } catch (parseError) {
                  console.error("Error parsing SSE data:", parseError);
                }
              }
            }
          }
        }
      } catch (err) {
        console.error("Error fetching news:", err);
        setError("Failed to fetch latest news");
      } finally {
        setLoading(false);
      }
    };

    fetchLatestNews();
  }, [selectedCountry]);

  // Generate images with URLs from the latest news data
  const imageUrlPairs = generateImagesWithUrls(newsItems);

  if (loading) {
    return (
      <div className="mx-auto mt-10 mb-2 max-w-7xl rounded-3xl p-8">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 dark:border-white mx-auto"></div>
          <p className="mt-2 text-gray-600 dark:text-gray-400">
            Loading latest news...
          </p>
        </div>
      </div>
    );
  }

  if (error && newsItems.length === 0) {
    return (
      <div className="mx-auto mt-10 mb-2 max-w-7xl rounded-3xl p-8">
        <div className="text-center">
          <p className="text-red-500">{error}</p>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
            Unable to fetch latest news. Please try again later.
          </p>
        </div>
      </div>
    );
  }

  if (newsItems.length === 0) {
    return (
      <div className="mx-auto mt-10 mb-2 max-w-7xl rounded-3xl p-8">
        <div className="text-center">
          <p className="text-gray-500 dark:text-gray-400">
            No news articles available at the moment.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-10 mb-2 max-w-7xl rounded-3xl p-2 opacity-30">
      <div className="mb-4 text-center">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white opacity-50">
          Latest News
        </h3>
        <div className="flex items-center gap-2 justify-center mt-2">
          <span className="text-sm text-gray-600 dark:text-gray-400 opacity-50">
            from
          </span>
          <div className="w-48">
            <Select value={selectedCountry} onValueChange={setSelectedCountry}>
              <SelectTrigger className="w-full h-8 text-sm">
                <SelectValue placeholder="Select country" />
              </SelectTrigger>
              <SelectContent>
                {countries.map((country) => (
                  <SelectItem key={country.value} value={country.value}>
                    {country.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex items-center justify-center gap-4 mt-2">
          <p className="text-sm text-gray-600 dark:text-gray-400 flex items-center gap-1 opacity-50">
            Latest articles fetched by{" "}
            <Image
              src="/valyu.svg"
              alt="Valyu"
              width={60}
              height={60}
              className="h-5 opacity-80 dark:invert"
            />
          </p>
        </div>
      </div>
      {imageUrlPairs.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {imageUrlPairs.slice(0, 6).map((item, index) => (
            <a
              key={index}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block group"
            >
              <div className="relative h-48 rounded-lg overflow-hidden shadow-md">
                <Image
                  src={item.image}
                  alt="News image"
                  fill
                  className="object-cover group-hover:scale-105 transition-transform duration-300"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
                <div className="absolute bottom-0 left-0 right-0 p-3 text-white">
                  <p className="text-sm font-medium line-clamp-2">
                    {newsItems[index]?.title || "News Article"}
                  </p>
                  <p className="text-xs opacity-80 mt-1">
                    {newsItems[index]?.source || "News Source"}
                  </p>
                </div>
              </div>
            </a>
          ))}
        </div>
      ) : (
        <div className="flex items-center justify-center h-48 rounded-lg">
          <p className="text-gray-500 dark:text-gray-400">
            No news images available
          </p>
        </div>
      )}
    </div>
  );
}
