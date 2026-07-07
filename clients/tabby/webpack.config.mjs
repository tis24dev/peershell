// Self-contained plugin build. Mirrors Tabby's webpack.plugin.config.mjs but imports the toolchain
// from THIS repo's node_modules (the /opt/tabby checkout is source-only, not installed), and bundles
// our own code + @peershell/protocol (+ xterm later). Angular/RxJS/@ng-bootstrap/ngx-toastr/tabby-*
// are externalized: Tabby provides them at runtime.
import * as fs from 'fs'
import * as path from 'path'
import * as url from 'url'
import wp from 'webpack'
import { AngularWebpackPlugin } from '@ngtools/webpack'
import { createEs2015LinkerPlugin } from '@angular/compiler-cli/linker/babel'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const root = path.resolve(__dirname, '..', '..')

const linkerPlugin = createEs2015LinkerPlugin({
    linkerJitMode: true,
    fileSystem: {
        resolve: path.resolve,
        exists: fs.existsSync,
        dirname: path.dirname,
        relative: path.relative,
        readFile: fs.readFileSync,
    },
})

export default () => {
    const isDev = !!process.env.TABBY_DEV
    return {
        target: 'node',
        entry: path.resolve(__dirname, 'src/index.ts'),
        context: __dirname,
        mode: isDev ? 'development' : 'production',
        devtool: false,
        optimization: { minimize: false },
        output: {
            path: path.resolve(__dirname, 'dist'),
            filename: 'index.js',
            pathinfo: true,
            libraryTarget: 'umd',
            publicPath: 'auto',
        },
        resolve: {
            modules: [
                path.join(__dirname, 'src'),
                path.join(__dirname, 'node_modules'),
                path.join(root, 'node_modules'),
                'node_modules',
            ],
            extensions: ['.ts', '.js'],
            mainFields: ['esm2015', 'browser', 'module', 'main'],
        },
        resolveLoader: {
            modules: [path.join(root, 'node_modules'), path.join(__dirname, 'node_modules'), 'node_modules'],
        },
        ignoreWarnings: [/Failed to parse source map/],
        module: {
            rules: [
                {
                    test: /\.js$/,
                    enforce: 'pre',
                    use: {
                        loader: 'source-map-loader',
                        options: {
                            filterSourceMappingUrl: (_url, resourcePath) => {
                                if (/node_modules/.test(resourcePath) && !resourcePath.includes('xterm')) {
                                    return false
                                }
                                return true
                            },
                        },
                    },
                },
                {
                    test: /\.(m?)js$/,
                    loader: 'babel-loader',
                    options: {
                        plugins: [linkerPlugin],
                        compact: false,
                        cacheDirectory: true,
                    },
                    resolve: { fullySpecified: false },
                },
                {
                    test: /\.ts$/,
                    use: [{ loader: '@ngtools/webpack' }],
                },
                {
                    test: /\.pug$/,
                    use: [
                        'apply-loader',
                        { loader: 'pug-loader', options: { pretty: true } },
                    ],
                },
                { test: /\.scss$/, use: ['@tabby-gang/to-string-loader', 'css-loader', 'sass-loader'], include: /(theme.*|component)\.scss/ },
                { test: /\.scss$/, use: ['style-loader', 'css-loader', 'sass-loader'], exclude: /(theme.*|component)\.scss/ },
                { test: /\.css$/, use: ['@tabby-gang/to-string-loader', 'css-loader'], include: /component\.css/ },
                { test: /\.css$/, use: ['style-loader', 'css-loader'], exclude: /component\.css/ },
                { test: /\.yaml$/, use: ['yaml-loader'] },
                { test: /\.svg/, use: ['svg-inline-loader'] },
                { test: /\.html$/, type: 'asset/source' },
            ],
        },
        externals: [
            '@electron/remote',
            'child_process',
            'electron',
            'fs',
            'net',
            'ngx-toastr',
            'os',
            'path',
            'readline',
            'stream',
            /^@angular(?!\/common\/locales)/,
            /^@ng-bootstrap/,
            /^rxjs/,
            /^tabby-/,
        ],
        plugins: [
            new wp.SourceMapDevToolPlugin({
                exclude: [/node_modules/, /vendor/],
                filename: '[file].map',
                moduleFilenameTemplate: 'webpack-tabby-peershell:///[resource-path]',
            }),
            new AngularWebpackPlugin({
                tsconfig: path.resolve(__dirname, 'tsconfig.json'),
                directTemplateLoading: false,
                jitMode: true,
            }),
        ],
    }
}
