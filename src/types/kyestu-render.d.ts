/**
 * Hand-written type shim for the vendored @kyestu/render workspace package:
 * tsconfig.typecheck.json maps the package here so the root typecheck does
 * not compile packages/ sources.
 *
 * DRIFT GUARD: tests/shim-drift.test.ts asserts at runtime that every value
 * declared here exists on the real module with a matching shape, and that
 * every real top-level value export is declared here. Any upstream sync of
 * packages/render must update this file in the same commit; otherwise the
 * drift test fails.
 */
declare module '@kyestu/render' {
  // ---- img ----------------------------------------------------------------
  export class ImgConverter {
    constructor()
    articleToImg(article: any, template?: string | { templateName?: string; features?: string[] }): Promise<Buffer>
  }
  export function loadDynamicAsset(...args: any[]): any
  export function isSupportedOpenTypeFont(...args: any[]): boolean
  export function resolveSatoriFontLang(...args: any[]): any

  // ---- text -----------------------------------------------------------------
  export interface ArticleTextOptions {
    compact?: boolean
    [key: string]: unknown
  }
  export function articleToText(article: any, options?: ArticleTextOptions): string
  export function compactArticleToText(article: any, options?: ArticleTextOptions): string
  export function extractArticleHeadline(article: any): string | null
  export function extractTextHeadline(text: any): string | null
  export function followsToText(...args: any[]): string
  export function formatWebsiteCardText(article: any): string
  export function formatArticleActionLabel(...args: any[]): string
  export function formatArticleAttributionLine(...args: any[]): string
  export function formatArticleAttributionTimeToken(...args: any[]): string
  export function formatArticleHeaderLine(...args: any[]): string
  export function formatArticlePlatformLabel(...args: any[]): string
  export function formatArticlePlainTimeToken(...args: any[]): string
  export function formatArticleSourceActionAttribution(...args: any[]): string
  export function formatArticleSourceActionLabel(...args: any[]): string
  export function formatArticleTimeToken(...args: any[]): string
  export function formatArticleUserId(...args: any[]): string
  export function formatCompactMetaline(...args: any[]): string
  export function formatMetaline(...args: any[]): string
  export function formatPassthroughAttributionLine(...args: any[]): string
  export function formatPassthroughTitleLine(...args: any[]): string
  export function formatTime(...args: any[]): string
  export function formatTranslationPassthrough(...args: any[]): string
  export function parseRawContent(...args: any[]): any
  export function parseTranslationContent(...args: any[]): any
  export const PASSTHROUGH_CARD_DEFERRED_MARKER: string
}
