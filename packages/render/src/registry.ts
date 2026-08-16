import type { Article } from './types'
import type { JSX } from 'react/jsx-runtime'
import { articleParser as DefaultCardParser } from '../template/img/DefaultCard'

type RenderParserOptions = {
    features?: Array<string>
}
type RenderParser = (
    article: Article,
    options?: RenderParserOptions,
) => {
    component: JSX.Element
    height: number
}

class TemplateRegistry {
    private static instance: TemplateRegistry
    private parsers: Map<string, RenderParser> = new Map()

    private constructor() {
        // Register default template
        this.register('default', DefaultCardParser)
    }

    public static getInstance(): TemplateRegistry {
        if (!TemplateRegistry.instance) {
            TemplateRegistry.instance = new TemplateRegistry()
        }
        return TemplateRegistry.instance
    }

    public register(name: string, parser: RenderParser) {
        this.parsers.set(name, parser)
    }

    public get(name: string): RenderParser | undefined {
        return this.parsers.get(name)
    }

    public getOrDefault(name?: string): RenderParser {
        if (name && this.parsers.has(name)) {
            return this.parsers.get(name)!
        }
        return this.parsers.get('default')!
    }
}

export { TemplateRegistry, type RenderParser, type RenderParserOptions }
