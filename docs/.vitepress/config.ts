import { defineConfig } from "vitepress";

export default defineConfig({
  title: "runoff",
  description:
    "Multi-step code-change pipelines for coding agents — race mode, git worktree isolation, local traces",
  base: "/runoff/",
  ignoreDeadLinks: true,

  head: [["link", { rel: "icon", href: "/runoff/favicon.ico" }]],

  themeConfig: {
    logo: { light: "/logo-light.svg", dark: "/logo-dark.svg", alt: "runoff" },

    nav: [
      { text: "Guide", link: "/guides/getting-started-30min" },
      { text: "Features", link: "/features/race-mode" },
      { text: "Architecture", link: "/architecture/structure" },
      { text: "Reference", link: "/reference/differentiation" },
      {
        text: "GitHub",
        link: "https://github.com/alexangelzhang/runoff",
      },
    ],

    sidebar: [
      {
        text: "Getting Started",
        items: [
          { text: "Introduction", link: "/" },
          { text: "30-minute guide", link: "/guides/getting-started-30min" },
          { text: "MCP host setup", link: "/guides/mcp-host-setup" },
          { text: "Coding agent backends", link: "/guides/coding-agent-backends" },
          { text: "Mock → real CLI", link: "/guides/mock-to-real-cli" },
          { text: "Provider plugins", link: "/guides/provider-plugin" },
        ],
      },
      {
        text: "Features",
        items: [
          { text: "Race mode", link: "/features/race-mode" },
          { text: "Observability", link: "/features/observability" },
          { text: "Observability eval", link: "/features/observability-eval" },
          { text: "Pipeline hooks", link: "/architecture/pipeline-hooks-runtime" },
          { text: "Reflect & re-plan", link: "/features/deerflow-reflect" },
          { text: "Memory (production)", link: "/features/memory-production" },
          { text: "External memory", link: "/features/external-memory" },
        ],
      },
      {
        text: "Architecture",
        items: [
          { text: "Project structure", link: "/architecture/structure" },
          { text: "Execution layers", link: "/architecture/execution-layers" },
          { text: "Trace lifecycle", link: "/architecture/trace-lifecycle" },
          { text: "Governance config", link: "/architecture/governance-config" },
          { text: "Memory layers", link: "/architecture/memory-layers" },
          { text: "Security model", link: "/architecture/security-model" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Why runoff", link: "/reference/differentiation" },
          { text: "Race showcase", link: "/reference/race-showcase" },
          { text: "Benchmarks", link: "/reference/benchmarks" },
          { text: "Benchmark data", link: "/reference/benchmarks-data" },
          { text: "Supported backends", link: "/reference/supported-backends" },
        ],
      },
      {
        text: "Operations",
        items: [
          { text: "Testing", link: "/guides/testing" },
          { text: "CI & branch protection", link: "/operations/ci-branch-protection" },
          { text: "Timeouts", link: "/operations/timeouts" },
          { text: "Stability boundaries", link: "/operations/stability-boundaries" },
          { text: "Real provider smoke", link: "/operations/real-provider-smoke" },
          { text: "Release checklist", link: "/operations/release-publish-checklist" },
        ],
      },
      {
        text: "Advanced",
        items: [
          { text: "Overview", link: "/advanced/" },
          { text: "A2A federation", link: "/features/a2a-federation" },
          { text: "Dream", link: "/features/dream" },
          { text: "Dreamify", link: "/features/dreamify" },
          { text: "Memory roadmap", link: "/features/memory-dream-roadmap" },
        ],
      },
    ],

    editLink: {
      pattern: "https://github.com/alexangelzhang/runoff/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    footer: {
      message: "Released under the MIT License.",
      copyright: "runoff — multi-step code-change pipelines for coding agents",
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/alexangelzhang/runoff" },
    ],

    search: {
      provider: "local",
    },
  },
});
