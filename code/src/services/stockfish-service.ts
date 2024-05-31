import { EventEmitter } from '../commons';
import StockfishWeb from 'lila-stockfish-web';

declare var WebAssembly: any;

class StockfishService {

    private stockfish: any;
    private _version!: string;
    private _usingLilaStockfish!: boolean;
    private _messageEmitter: EventEmitter<string> = new EventEmitter<string>();
    private avoidNotifications = false;

    constructor() { }

    get version(): string { return this._version; }
    get messageEmitter(): EventEmitter<string> { return this._messageEmitter; }

    public postMessage(message: string) {
        if (this._usingLilaStockfish)
            this.stockfish.uci(message);
        else
            this.stockfish.postMessage(message);
    }

    public onMessage(message: string) {
        console.log(message);
        if (!this.avoidNotifications) this._messageEmitter.notify(message);
    }

    public warmup(fen: string) {
        this.avoidNotifications = true;
        this.postMessage(`position fen ${fen}`);
        this.postMessage('go infinite');
    }

    public stopWarmup(): Promise<void> {
        console.log('stopWarmup...');
        return new Promise(resolve => {
            if (this._usingLilaStockfish) {
                const stockfishListener = (msg: string) => {
                    console.log('stopWarmup listener...' + msg);
                    if (msg.startsWith('bestmove')) {
                        clearTimeout(timeout);
                        this.avoidNotifications = false;
                        this.stockfish.listen = (msg: string) => { this.onMessage(msg); }
                        console.log('stopWarmup resolve...');
                        resolve();
                    }
                }
                this.stockfish.listen =  (msg: string) => { stockfishListener(msg); }
                const timeout = setTimeout(() => {
                    this.avoidNotifications = false;
                    this.stockfish.listen = (msg: string) => { this.onMessage(msg); }
                    resolve();
                }, 500);
            } else {
                const stockfishListener = (event: MessageEvent<string>) => {
                    console.log('stopWarmup listener...' + event.data);
                    if (event.data.startsWith('bestmove')) {
                        clearTimeout(timeout);
                        this.avoidNotifications = false;
                        this.stockfish.removeEventListener('message', stockfishListener);
                        resolve();
                    }
                }
                this.stockfish.addEventListener('message', stockfishListener);
                const timeout = setTimeout(() => {
                    this.avoidNotifications = false;
                    this.stockfish.removeEventListener('message', stockfishListener);
                    resolve();
                }, 500);
            }
            this.postMessage('stop');
        });
    }

    private sharedWasmMemory = (lo: number, hi = 32767): WebAssembly.Memory => {
        let shrink = 4; // 32767 -> 24576 -> 16384 -> 12288 -> 8192 -> 6144 -> etc
        while (true) {
            try {
                return new WebAssembly.Memory({ shared: true, initial: lo, maximum: hi });
            } catch (e) {
                if (hi <= lo || !(e instanceof RangeError)) throw e;
                hi = Math.max(lo, Math.ceil(hi - hi / shrink));
                shrink = shrink === 4 ? 3 : 4;
            }
        }
    };

    private sharedMemoryTest(): boolean {
        if (typeof Atomics !== 'object') return false;
        if (typeof SharedArrayBuffer !== 'function') return false;
        let mem;
        try {
            mem = new WebAssembly.Memory({ shared: true, initial: 1, maximum: 2 });
            if (!(mem.buffer instanceof SharedArrayBuffer)) return false;

            window.postMessage(mem.buffer, '*');
        } catch (_) {
            return false;
        }
        return mem.buffer instanceof SharedArrayBuffer;
    }

    private detectFeatures(): string[] {
        const result: string[] = [];
        if (typeof WebAssembly === 'object' &&
            typeof WebAssembly.validate === 'function' &&
            WebAssembly.validate(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]))) {
            result.push('wasm');
            if (this.sharedMemoryTest()) {
                result.push('sharedMem');
                // i32x4.dot_i16x8_s, i32x4.trunc_sat_f64x2_u_zero
                const sourceWithSimd = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 1, 12, 2, 96, 2, 123, 123, 1, 123, 96, 1, 123, 1, 123, 3, 3, 2, 0, 1, 7, 9, 2, 1, 97, 0, 0, 1, 98, 0, 1, 10, 19, 2, 9, 0, 32, 0, 32, 1, 253, 186, 1, 11, 7, 0, 32, 0, 253, 253, 1, 11]); // prettier-ignore
                if (WebAssembly.validate(sourceWithSimd)) result.push('simd');
            }
        }
        return result;
    }

    private initLilaStockfish() {
        import('lila-stockfish-web/sf16-7.js').then((makeModule: any) => {
            makeModule
                .default({
                    wasmMemory: this.sharedWasmMemory(1536!),
                    onError: (msg: string) => console.log(msg),
                    locateFile: (name: string) => `assets/stockfish/${name}`,
                })
                .then(async (stockfish: StockfishWeb) => {
                    this._usingLilaStockfish = true;
                    this.stockfish = stockfish;
                    const response = await fetch(`assets/stockfish/${stockfish.getRecommendedNnue()}`);
                    const buffer = await response.arrayBuffer();
                    const uint8Array = new Uint8Array(buffer);
                    stockfish.setNnueBuffer(uint8Array);
                    stockfish.onError = (msg: string) => { console.log(msg); }
                    stockfish.listen = (msg: string) => { this.onMessage(msg); }
                    stockfish.uci('uci');
                });
        });
    }

    private initStockfishNnue16NoSimd() {
        this._usingLilaStockfish = false;
        const self = this;
        this.stockfish = new Worker('assets/stockfish/stockfish-nnue-16-no-simd.js#stockfish-nnue-16-no-simd.wasm');
        this.stockfish.addEventListener('message', (event: MessageEvent<string>) => {
            console.log(event.data);
            self.onMessage.call(self, event.data);
        });
        this.stockfish.postMessage('uci');
    }

    private initStockfish() {
        const features = this.detectFeatures();
        if (features.includes("simd")) {
            this.initLilaStockfish();
        } else {
            this.initStockfishNnue16NoSimd();
        }
    }

    public init(): Promise<boolean> {
        return new Promise(resolve => {
            const stockfishListener = (message: string) => {
                if (!this._version) this._version = message;
                if ('uciok' == message) {
                    this._messageEmitter.removeEventListener(stockfishListener);
                    resolve(true);
                }
            }
            this._messageEmitter.addEventListener(stockfishListener);
            this.initStockfish();
        });
    }

}

export const stockfishService = new StockfishService();
