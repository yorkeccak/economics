# Economics AI Assistant

> **The world's most powerful open-source economics AI assistant** — Access real-time macroeconomic indicators from FRED, BLS, World Bank, IMF, and OECD; analyze global trends; and generate insightful forecasts and visualizations — all through natural conversation.

🚀 **[Try the live demo at economics.valyu.ai](https://economics.valyu.ai)**

![Economics by Valyu](public/economics.png)

## Why Economics?

Traditional economic research is fragmented across dozens of databases and platforms. Economics AI Assistant changes everything by providing:

- **📊 Comprehensive Economic Data** - Real-time access to FRED, BLS, World Bank, IMF, and OECD datasets
- **🔍 One Unified Search** - Powered by Valyu's comprehensive economics data API
- **🐍 Advanced Analytics** - Execute Python code in secure Daytona sandboxes for econometric analysis, forecasting, and visualization
- **📈 Interactive Visualizations** - Beautiful charts for macroeconomic indicators, trend analysis, and comparative studies
- **🌐 Real-Time Intelligence** - Web search integration for breaking economic news and policy updates
- **🏠 Local AI Models** - Run with Ollama for unlimited, private queries using your own hardware
- **🎯 Natural Language** - Just ask questions like you would to a colleague

## Key Features

### 🔥 Powerful Economics Tools

- **FRED Integration** - Access Federal Reserve Economic Data with thousands of US and international indicators
- **BLS Data** - Bureau of Labor Statistics data including employment, inflation, and productivity metrics
- **World Bank** - Global development indicators, poverty statistics, and country-level economic data
- **IMF Data** - International Monetary Fund statistics on global finance, trade, and economic stability
- **OECD Statistics** - Economic indicators from developed countries including GDP, trade, and policy measures
- **Cross-Source Analysis** - Compare and analyze data from multiple sources in one query

### 🛠️ Advanced Tool Calling

- **Python Code Execution** - Run econometric analyses, time series forecasting, and custom data processing
- **Interactive Charts** - Create publication-ready visualizations of economic trends
- **Multi-Source Research** - Automatically aggregates data from multiple economic databases
- **Export & Share** - Download results, share analyses, and collaborate

## 🚀 Quick Start

### Prerequisites

**For Cloud Usage:**
- Node.js 18+
- npm or pnpm
- OpenAI API key
- Valyu API key (get one at [platform.valyu.ai](https://platform.valyu.ai))
- Daytona API key (for code execution)

**For Local AI Models:**
- All of the above, plus:
- [Ollama](https://ollama.com) installed and running
- At least one model installed (qwen2.5:7b recommended)

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/economics.git
   cd economics
   ```

2. **Install dependencies**
   ```bash
   npm install
   # or
   pnpm install
   ```

3. **Set up environment variables**

   Create a `.env.local` file in the root directory:
   ```env
   # OpenAI Configuration
   OPENAI_API_KEY=your-openai-api-key

   # Valyu API Configuration
   VALYU_API_KEY=your-valyu-api-key

   # Daytona Configuration (for Python execution)
   DAYTONA_API_KEY=your-daytona-api-key
   DAYTONA_API_URL=https://api.daytona.io  # Optional
   DAYTONA_TARGET=latest  # Optional

   # App Configuration
   NEXT_PUBLIC_APP_URL=http://localhost:3000  # Your deployment URL in production
   NEXT_PUBLIC_APP_MODE=development  # Use 'development' or 'production'

   # Ollama Configuration (Optional - for local models)
   # By default, Ollama support is DISABLED for production mode
   # To enable Ollama support, set NEXT_PUBLIC_APP_MODE=development
   OLLAMA_BASE_URL=http://localhost:11434  # Default Ollama URL
   ```

4. **Run the development server**
   ```bash
   npm run dev
   ```

5. **Check your configuration (optional)**
   ```bash
   npm run check-config
   ```
   This will show you whether Ollama support is enabled or disabled.

6. **Open your browser**

   Navigate to [http://localhost:3000](http://localhost:3000)

### 🏠 Local Model Setup (Optional)

**Note**: By default, Ollama support is **disabled** for production mode. The app will use OpenAI/Vercel AI Gateway with rate limiting (5 queries/day).

For unlimited, private queries using your own hardware:

1. **Install Ollama**
   ```bash
   # macOS
   brew install ollama

   # Or download from https://ollama.com
   ```

2. **Start Ollama service**
   ```bash
   ollama serve
   ```

3. **Install recommended models**
   ```bash
   # Best for tool calling (recommended)
   ollama pull qwen2.5:7b

   # Alternative options
   ollama pull qwen2.5:14b    # Better but slower
   ollama pull llama3.1:7b    # Good general performance
   ```

4. **Switch to local model**

   Click the "Local Models" indicator in the top-right corner of the app to select your model.

**Model Recommendations:**
- **Qwen2.5:7B+** - Excellent for tool calling and economic analysis
- **Llama 3.1:7B+** - Good general performance with tools
- **Avoid smaller models** - Many struggle with complex function calling

## 💡 Example Queries

Try these powerful queries to see what Economics AI Assistant can do:

- "Show me US unemployment rate trends over the past 5 years from BLS"
- "Compare GDP growth rates between G7 countries using OECD data"
- "What's the current inflation rate and how does it compare to historical averages?"
- "Analyze the relationship between interest rates and housing prices using FRED data"
- "Get World Bank poverty statistics for Sub-Saharan Africa"
- "Compare IMF growth forecasts with actual GDP performance for emerging markets"
- "Create a visualization of the yield curve using Treasury data from FRED"

**With Local Models (Ollama):**
- Run unlimited queries without API costs
- Keep all your economic research completely private
- Perfect for proprietary analysis and sensitive data

## 🏗️ Architecture

- **Frontend**: Next.js 15 with App Router, Tailwind CSS, shadcn/ui
- **AI**: OpenAI GPT-4 with function calling + Ollama for local models
- **Data**: Valyu API for comprehensive economic data (FRED, BLS, World Bank, IMF, OECD)
- **Code Execution**: Daytona sandboxes for secure Python execution
- **Visualizations**: Recharts for interactive charts
- **Real-time**: Streaming responses with Vercel AI SDK
- **Local Models**: Ollama integration for private, unlimited queries

## 🔒 Security

- Secure API key management
- Sandboxed code execution via Daytona
- No storage of sensitive proprietary data
- HTTPS encryption for all API calls
- Secure data handling practices

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 🙏 Acknowledgments

- Built with [Valyu](https://platform.valyu.ai) - The unified economics data API
- Powered by [Daytona](https://daytona.io) - Secure code execution
- UI components from [shadcn/ui](https://ui.shadcn.com)

---

<p align="center">
  Made with ❤️ by the Valyu team
</p>

<p align="center">
  <a href="https://twitter.com/ValyuNetwork">Twitter</a> •
  <a href="https://www.linkedin.com/company/valyu-network">LinkedIn</a> •
  <a href="https://github.com/yorkeccak/economics">GitHub</a>
</p>
