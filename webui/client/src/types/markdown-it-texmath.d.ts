declare module 'markdown-it-texmath' {
    import type { KatexOptions } from 'katex';
    import type MarkdownIt from 'markdown-it';

    interface TexmathOptions {
        engine: any;
        delimiters?: string;
        katexOptions?: KatexOptions;
    }

    function texmath(md: MarkdownIt, options?: TexmathOptions): void;
    export default texmath;
}
