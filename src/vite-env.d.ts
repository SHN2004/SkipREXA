/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DATA_SOURCE_STRATEGY?: "local-first" | "github-first";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
