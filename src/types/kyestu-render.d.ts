declare module '@kyestu/render' {
  export class ImgConverter {
    constructor()
    articleToImg(article: any, template?: string | { templateName?: string; features?: string[] }): Promise<Buffer>
  }
  export function articleToText(article: any, options?: Record<string, unknown>): string
  export function compactArticleToText(article: any, options?: Record<string, unknown>): string
  export function formatWebsiteCardText(article: any): string
  export function extractArticleHeadline(article: any): string | null
}
