"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { useTheme } from "next-themes";
import CodeSnippetDialog from "./code-snippet-dialog";

const logos = [
  {
    name: "SEC Filings",
    src: "/sec.svg",
    description: "Access SEC EDGAR filings",
    snippets: [
      {
        language: "Python",
        code: `from valyu import Valyu

valyu = Valyu(api_key="<your_api_key>")

# Search for specific SEC filings
response = valyu.search(
    "Pfizer 10-K filing from 2023",
    included_sources=["valyu/valyu-sec-filings"]
    # or leave included_sources empty and we'll figure it out for you
)

# Access the results
for result in response.results:
    print(f"Title: {result.title}")
    print(f"Content: {result.content[:200]}...")`,
      },
      {     
        language: "TypeScript",
        code: `import { Valyu } from 'valyu';

const valyu = new Valyu({ apiKey: '<your_api_key>' });

// Search for specific SEC filings
const response = await valyu.search({
    query: 'Pfizer 10-K filing from 2023',
    includedSources: ['valyu/valyu-sec-filings'],
    // or leave included_sources empty and we'll figure it out for you
});

// Access the results
response.results.forEach(result => {
    