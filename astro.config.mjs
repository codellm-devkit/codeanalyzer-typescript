import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import mermaid from "astro-mermaid";
import { pluginCollapsibleSections } from "@expressive-code/plugin-collapsible-sections";
import { pluginLineNumbers } from "@expressive-code/plugin-line-numbers";

// https://astro.build/config
export default defineConfig({
  site: "https://codellm-devkit.github.io",
  base: "/codeanalyzer-typescript",
  integrations: [
    // Mermaid must run BEFORE Starlight so it can preprocess ```mermaid blocks.
    mermaid({
      theme: "neutral",
      autoTheme: true,
      mermaidConfig: {
        flowchart: { curve: "basis" },
      },
    }),
    starlight({
      title: "codeanalyzer-typescript",
      tagline: "Static analysis for TypeScript your agents can call.",
      description:
        "codeanalyzer-typescript turns a TypeScript/JavaScript project into a canonical symbol table and call graph — emitted as one typed analysis.json artifact or projected into a queryable Neo4j property graph — using the TypeScript compiler via ts-morph. The TypeScript backend behind CLDK.",
      logo: {
        src: "./src/assets/logo.png",
        replacesTitle: true,
      },
      favicon: "/favicon.png",
      customCss: ["./src/styles/docs.css"],
      expressiveCode: {
        plugins: [pluginCollapsibleSections(), pluginLineNumbers()],
        styleOverrides: {
          borderRadius: "0.4rem",
          frames: {
            shadowColor: "transparent",
          },
        },
        defaultProps: {
          showLineNumbers: false,
        },
      },
      head: [
        {
          tag: "link",
          attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" },
        },
        {
          tag: "link",
          attrs: {
            rel: "preconnect",
            href: "https://fonts.gstatic.com",
            crossorigin: "",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "stylesheet",
            href: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap",
          },
        },
      ],
      social: [
        {
          icon: "github",
          label: "codeanalyzer-typescript on GitHub",
          href: "https://github.com/codellm-devkit/codeanalyzer-typescript",
        },
        {
          icon: "seti:typescript",
          label: "codeanalyzer-typescript releases",
          href: "https://github.com/codellm-devkit/codeanalyzer-typescript/releases",
        },
        {
          icon: "discord",
          label: "CLDK on Discord",
          href: "https://discord.gg/zEjz9YrmqN",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/codellm-devkit/codeanalyzer-typescript/edit/docs/",
      },
      sidebar: [
        {
          label: "Start here",
          items: [
            {
              label: "What is codeanalyzer-typescript?",
              slug: "what-is-codeanalyzer",
            },
            { label: "Quickstart", slug: "quickstart" },
            { label: "Installation", slug: "installing" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "CLI usage", slug: "guides/cli-usage" },
            { label: "Core concepts", slug: "guides/concepts" },
            {
              label: "Call graph & dispatch",
              slug: "guides/call-graph",
            },
            {
              label: "Level 2: CodeQL & entrypoints",
              slug: "guides/level-2",
            },
            { label: "Neo4j", slug: "guides/neo4j" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "CLI options", slug: "reference/cli" },
            { label: "Output schema", slug: "reference/schema" },
            { label: "Neo4j graph schema", slug: "reference/neo4j-schema" },
          ],
        },
      ],
    }),
  ],
});
