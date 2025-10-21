"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { motion } from "framer-motion";
import Image from "next/image";

interface NewsItem {
  title: string;
  url: string;
  image_url?: string | Record<string, string>;
  content: string;
  source: string;
  date?: string;
}

export function NewsCarousel({ country = "global" }: { country?: string }) {
  const [newsItems, setNewsItems] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [isHovered, setIsHovered] = useState(false);
  const [currentPosition, setCurrentPosition] = useState(0);
  const [animationStartTime, setAnimationStartTime] = useState(Date.now());
  const [hoverPosition, setHoverPosition] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState(0);
  const [dragOffset, setDragOffset] = useState(0);
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set());
  const motionRef = useRef<HTMLDivElement>(null);

  // Cache for storing news data by country
  const [newsCache, setNewsCache] = useState<
    Record<string, { data: NewsItem[]; timestamp: number }>
  >({});
  const [loadingStates, setLoadingStates] = useState<Record<string, boolean>>(
    {}
  );

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

  // Cache management functions
  const isCacheValid = useCallback(
    (country: string) => {
      const cacheEntry = newsCache[country];
      if (!cacheEntry) return false;

      const cacheAge = Date.now() - cacheEntry.timestamp;
      const oneHour = 60 * 60 * 1000; // 1 hour in milliseconds
      return cacheAge < oneHour;
    },
    [newsCache]
  );

  const getCachedNews = useCallback(
    (country: string) => {
      return newsCache[country]?.data || [];
    },
    [newsCache]
  );

  const setCachedNews = (country: string, data: NewsItem[]) => {
    setNewsCache((prev) => ({
      ...prev,
      [country]: {
        data,
        timestamp: Date.now(),
      },
    }));
  };

  const setLoadingState = (country: string, isLoading: boolean) => {
    setLoadingStates((prev) => ({
      ...prev,
      [country]: isLoading,
    }));
  };

  // Handle touch/mouse events for manual scrolling
  const handleStart = (clientX: number) => {
    setIsDragging(true);
    setDragStart(clientX);
    setDragOffset(0);
  };

  const handleMove = (clientX: number) => {
    if (!isDragging) return;
    const deltaX = clientX - dragStart;
    setDragOffset(deltaX);
  };

  const handleEnd = () => {
    if (!isDragging) return;
    setIsDragging(false);
    const newPosition = currentPosition + dragOffset;
    const contentWidth = imageUrlPairs.length * 160;
    const containerWidth = 400; // Approximate container width
    const maxScroll = Math.max(0, contentWidth - containerWidth);

    // Constrain position to boundaries
    const constrainedPosition = Math.max(-maxScroll, Math.min(0, newPosition));
    setCurrentPosition(constrainedPosition);
    setDragOffset(0);
  };

  // Calculate current position based on time elapsed
  const getCurrentPosition = () => {
    const now = Date.now();
    const elapsed = (now - animationStartTime) / 1000; // Convert to seconds
    const totalDuration = 60; // 60 seconds
    const progress = (elapsed % totalDuration) / totalDuration;

    return -200 * imageUrlPairs.length * progress;
  };

  useEffect(() => {
    const loadNewsForCountry = async () => {
      // Check if we have valid cached data
      if (isCacheValid(country)) {
        const cachedData = getCachedNews(country);
        setNewsItems(cachedData);
        setLoading(false);
        return;
      }

      // Check if we're already loading this country
      if (loadingStates[country]) {
        return;
      }

      // Set loading state for this country
      setLoadingState(country, true);
      setLoading(true);

      try {
        // Use streaming endpoint for progressive loading
        const response = await fetch(`/api/news/stream?country=${country}`);

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

                  if (data.type === "start") {
                    console.log(
                      `Starting to fetch ${data.total} queries for ${country}`
                    );
                  } else if (data.type === "results") {
                    // Add new results immediately
                    const newResults = data.results || [];
                    accumulatedResults = [...accumulatedResults, ...newResults];

                    // Filter to only include items with valid images
                    const itemsWithImages = accumulatedResults.filter(
                      (item: NewsItem) => {
                        if (!item.image_url) return false;
                        const imageUrl = item.image_url;
                        if (
                          typeof imageUrl === "string" &&
                          imageUrl.startsWith("http")
                        ) {
                          return true;
                        } else if (
                          typeof imageUrl === "object" &&
                          imageUrl !== null
                        ) {
                          const values = Object.values(imageUrl);
                          return values.some(
                            (val) =>
                              typeof val === "string" && val.startsWith("http")
                          );
                        }
                        return false;
                      }
                    );

                    // Update UI immediately with new results
                    setNewsItems(itemsWithImages);
                  } else if (data.type === "complete") {
                    // Final processing and caching
                    const finalItems = accumulatedResults.filter(
                      (item: NewsItem) => {
                        if (!item.image_url) return false;
                        const imageUrl = item.image_url;
                        if (
                          typeof imageUrl === "string" &&
                          imageUrl.startsWith("http")
                        ) {
                          return true;
                        } else if (
                          typeof imageUrl === "object" &&
                          imageUrl !== null
                        ) {
                          const values = Object.values(imageUrl);
                          return values.some(
                            (val) =>
                              typeof val === "string" && val.startsWith("http")
                          );
                        }
                        return false;
                      }
                    );

                    // Cache the final data
                    setCachedNews(country, finalItems);
                    setNewsItems(finalItems);
                  }
                } catch (parseError) {
                  console.error("Error parsing SSE data:", parseError);
                }
              }
            }
          }
        }
      } catch (error) {
        console.error(`Error streaming news for ${country}:`, error);

        // Fallback to regular API if streaming fails
        try {
          console.log(`Falling back to regular API for ${country}`);
          const fallbackResponse = await fetch(
            `/api/news?country=${country}&refresh=true`
          );
          if (fallbackResponse.ok) {
            const data = await fallbackResponse.json();
            const newsItems = data.newsItems || [];
            setCachedNews(country, newsItems);
            setNewsItems(newsItems);
          }
        } catch (fallbackError) {
          console.error(`Fallback also failed for ${country}:`, fallbackError);
        }
      } finally {
        setLoadingState(country, false);
        setLoading(false);
      }
    };

    loadNewsForCountry();
  }, [country, getCachedNews, isCacheValid, loadingStates]);

  // Function to validate if URL is a specific article
  const isValidArticle = (url: string): boolean => {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname.toLowerCase();

      // Additional client-side validation for article URLs
      const articlePatterns = [
        /\d{4}\/\d{2}\/\d{2}/, // Date pattern
        /\d{8}/, // 8-digit date
        /article/,
        /story/,
        /post/,
        /report/,
        /news\/\d{4}/, // news/2024 pattern
        /\/\d{4}\/\d{2}\//, // /2024/01/ pattern
      ];

      const aggregatorPatterns = [
        "/news/",
        "/headlines/",
        "/breaking/",
        "/latest/",
        "/category/",
        "/section/",
        "/topic/",
        "/tag/",
        "/search",
        "/results",
        "/archive",
        "/home",
        "/index",
        "/",
      ];

      // Simple validation - just exclude obvious non-articles
      const isNotLandingPage =
        !pathname.includes("category") &&
        !pathname.includes("section") &&
        !pathname.includes("tag") &&
        !pathname.includes("search") &&
        !pathname.includes("archive") &&
        pathname !== "/" &&
        pathname.length > 3;

      return isNotLandingPage;
    } catch {
      return false;
    }
  };

  // Function to generate images with their corresponding news URLs
  const generateImagesWithUrls = (
    newsData: NewsItem[]
  ): { image: string; url: string; title: string; source: string }[] => {
    const imageUrlPairs: {
      image: string;
      url: string;
      title: string;
      source: string;
    }[] = [];

    newsData.forEach((item) => {
      // Only process items with valid article URLs and valid images
      if (!isValidArticle(item.url) || !item.image_url) {
        return;
      }

      const imageUrl = item.image_url;
      let hasImage = false;

      if (typeof imageUrl === "string" && imageUrl.startsWith("http")) {
        imageUrlPairs.push({
          image: imageUrl,
          url: item.url,
          title: item.title,
          source: item.source,
        });
        hasImage = true;
      } else if (typeof imageUrl === "object" && imageUrl !== null) {
        const values = Object.values(imageUrl);
        values.forEach((val) => {
          if (typeof val === "string" && val.startsWith("http")) {
            imageUrlPairs.push({
              image: val,
              url: item.url,
              title: item.title,
              source: item.source,
            });
            hasImage = true;
          }
        });
      }
    });

    // Remove duplicates based on URL to ensure only one card per unique news
    const uniquePairs = imageUrlPairs.filter(
      (item, index, self) => index === self.findIndex((t) => t.url === item.url)
    );

    return uniquePairs;
  };

  if (loading) {
    const countryDisplayName =
      country === "global"
        ? "global"
        : countries.find((c) => c.value === country)?.label || country;

    return (
      <div className="w-full h-32 bg-gray-100 dark:bg-gray-800 rounded-lg flex items-center justify-center">
        <div className="text-center max-w-md">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-gray-900 dark:border-white mx-auto mb-3"></div>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
            Valyu&apos;s searching up {countryDisplayName} news for you.
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-500">
            Meanwhile check out what more we can do for you at{" "}
            <a
              href="https://platform.valyu.network/playground/search"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 underline"
            >
              platform.valyu.network
            </a>
          </p>
        </div>
      </div>
    );
  }

  if (newsItems.length === 0) {
    return (
      <div className="w-full h-32 bg-gray-100 dark:bg-gray-800 rounded-lg flex items-center justify-center">
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          No news available at the moment. Try refreshing the page.
        </p>
      </div>
    );
  }

  const imageUrlPairs = generateImagesWithUrls(newsItems).filter(
    (item) => !failedImages.has(item.image)
  );

  if (imageUrlPairs.length === 0) {
    return (
      <div className="w-full h-32 bg-gray-100 dark:bg-gray-800 rounded-lg flex items-center justify-center">
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          No news images available at the moment
        </p>
      </div>
    );
  }

  // Ensure we have enough items for smooth looping
  const minItemsForLoop = 5;
  if (imageUrlPairs.length < minItemsForLoop) {
    console.log(
      `Only ${imageUrlPairs.length} items available, may not loop smoothly`
    );
  }

  // Check if current data is from cache
  const isFromCache = isCacheValid(country);
  const cacheAge = newsCache[country]
    ? Date.now() - newsCache[country].timestamp
    : 0;
  const cacheAgeMinutes = Math.floor(cacheAge / (1000 * 60));

  return (
    <div
      className="w-full h-24 overflow-x-auto overflow-y-hidden relative bg-gray-50 dark:bg-gray-900/50 rounded-lg mb-4 scrollbar-hide"
      onMouseEnter={() => {
        setIsHovered(true);
      }}
      onMouseLeave={() => {
        setIsHovered(false);
        setAnimationStartTime(Date.now());
        handleEnd();
      }}
      onTouchStart={(e) => handleStart(e.touches[0].clientX)}
      onTouchMove={(e) => handleMove(e.touches[0].clientX)}
      onTouchEnd={handleEnd}
      onMouseDown={(e) => handleStart(e.clientX)}
      onMouseMove={(e) => handleMove(e.clientX)}
      onMouseUp={handleEnd}
    >
      <motion.div
        ref={motionRef}
        className="flex h-full"
        style={{
          width: `${imageUrlPairs.length * 160}px`, // Set explicit width for horizontal scrolling
        }}
        animate={{
          x:
            isHovered || isDragging
              ? currentPosition + dragOffset
              : (() => {
                  const contentWidth = imageUrlPairs.length * 160;
                  const containerWidth = 400;
                  const maxScroll = Math.max(0, contentWidth - containerWidth);
                  return -maxScroll; // Scroll to the end
                })(),
        }}
        transition={{
          duration: isDragging ? 0 : isHovered ? 0.3 : 30,
          ease: isHovered ? "easeOut" : "linear",
          repeat: isHovered || isDragging ? 0 : Infinity, // Infinite repeat when auto-scrolling
          repeatType: "loop", // Loop back to start
        }}
        onUpdate={(latest) => {
          if (!isHovered && !isDragging && typeof latest.x === "number") {
            setCurrentPosition(latest.x);
          }
        }}
        onAnimationComplete={() => {
          // Reset to start when animation completes
          if (!isHovered && !isDragging) {
            setCurrentPosition(0);
            setAnimationStartTime(Date.now());
          }
        }}
      >
        {/* First set of items */}
        {imageUrlPairs.map((item, index) => (
          <motion.a
            key={`first-${index}`}
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-shrink-0 w-36 h-24 mx-1 relative group cursor-pointer"
            whileHover={{ scale: 1.05 }}
            transition={{ duration: 0.2 }}
          >
            <div className="relative w-full h-full rounded-lg overflow-hidden shadow-md">
              <Image
                src={item.image}
                alt={item.title}
                fill
                className="object-cover group-hover:scale-110 transition-transform duration-300"
                onError={() => {
                  setFailedImages((prev) => new Set(prev).add(item.image));
                }}
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
              <div className="absolute bottom-0 left-0 right-0 p-2 text-white">
                <p className="text-xs font-medium line-clamp-2 mb-0.5">
                  {item.title}
                </p>
                <p className="text-xs opacity-80">{item.source}</p>
              </div>
            </div>
          </motion.a>
        ))}
        {/* Duplicate set for seamless loop */}
        {imageUrlPairs.map((item, index) => (
          <motion.a
            key={`second-${index}`}
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-shrink-0 w-36 h-24 mx-1 relative group cursor-pointer"
            whileHover={{ scale: 1.05 }}
            transition={{ duration: 0.2 }}
          >
            <div className="relative w-full h-full rounded-lg overflow-hidden shadow-md">
              <Image
                src={item.image}
                alt={item.title}
                fill
                className="object-cover group-hover:scale-110 transition-transform duration-300"
                onError={() => {
                  setFailedImages((prev) => new Set(prev).add(item.image));
                }}
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
              <div className="absolute bottom-0 left-0 right-0 p-2 text-white">
                <p className="text-xs font-medium line-clamp-2 mb-0.5">
                  {item.title}
                </p>
                <p className="text-xs opacity-80">{item.source}</p>
              </div>
            </div>
          </motion.a>
        ))}
      </motion.div>
    </div>
  );
}
