/**
 * Copyright (C) 2026 tis24dev
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

// Builds the browser web-client into a single self-contained dist/index.html (JS + CSS inlined),
// which the host embeds and serves over the reverse tunnel. Reuses @peershell/protocol from source.
import * as path from 'path'
import * as url from 'url'
import HtmlWebpackPlugin from 'html-webpack-plugin'
import HtmlInlineScriptPlugin from 'html-inline-script-webpack-plugin'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))

export default () => ({
    target: 'web',
    mode: 'production',
    entry: path.resolve(__dirname, 'src/index.ts'),
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'bundle.js',
    },
    resolve: {
        extensions: ['.ts', '.js'],
        alias: {
            '@peershell/protocol': path.resolve(__dirname, '../../shared/src/index.ts'),
        },
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: {
                    loader: 'ts-loader',
                    options: { configFile: path.resolve(__dirname, 'tsconfig.json') },
                },
            },
            { test: /\.css$/, use: ['style-loader', 'css-loader'] },
        ],
    },
    plugins: [
        new HtmlWebpackPlugin({
            template: path.resolve(__dirname, 'src/index.html'),
            inject: 'body',
            minify: false,
        }),
        new HtmlInlineScriptPlugin(),
    ],
})
