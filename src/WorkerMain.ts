///<reference path="WorkerChild.ts"/>
///<reference path="../lib/pbkdf2.js"/>
///<reference path="../lib/smix.js"/>

module WorkerMain {
    let maxPassLen = 64,
    maxSaltLen = 64,
    maxDkLen = 64,
    maxThread = 4;

    export let onready: () => void;
    export let onerror: (string) => void;
    export let oncomplete: (dkHex: Uint8Array) => void;

    let mArgP: number,
        mWorkerUrl: string,

        mAsmBuf: ArrayBuffer,
        mAsmU8: Uint8Array,
        mAsmMod = asm_pbkdf2(),

        // 利用类型推导机制，获取 asm.js 模块的实例类型
        mAsmObj =  null,

        mPassPtr: number,
        mSaltPtr: number,
        mDkPtr: number,
        mBlksPtr: number,

        mPassLen: number,
        mSaltLen: number,
        mDkLen: number,
        mBlkLen: number,

        mThreads: number,
        mWorkerPool: Worker[] = [],

        mReadyCounter: number,
        mDoingCounter: number,
        mDoneCounter: number;


    export function config(N: number, r: number, P: number, thread: number) {
        if (thread == null) {
            let taskPerThread = Math.ceil(P / maxThread);
            thread = Math.ceil(P / taskPerThread);
        }
        mBlkLen = 128 * r;
        mArgP = P;

        mThreads = thread;
        mReadyCounter = 0;

        // pbkdf2 memory alloc
        let ptr = mAsmMod.getHeap();

        mPassPtr = ptr;
        ptr += maxPassLen;

        mSaltPtr = ptr;
        ptr += maxSaltLen;

        mDkPtr = ptr;
        ptr += maxDkLen;

        mBlksPtr = ptr;
        ptr += (mBlkLen * P);

        ptr = Math.ceil(ptr / 65536) * 65536;

        // init asm.js module
        if (!mAsmBuf || mAsmBuf.byteLength < ptr) {
            mAsmBuf = new ArrayBuffer(ptr);
            mAsmU8 = new Uint8Array(mAsmBuf);
            mAsmObj = mAsmMod.create(mAsmBuf);
        }

        if (!mWorkerUrl) {
            mWorkerUrl = createWorkerUrl();
        }

        for (let i = 0; i < mThreads; i++) {
            let worker = mWorkerPool[i];
            if (!worker) {
                worker = new Worker(mWorkerUrl);
                worker.onmessage = msgHander;
                worker['tag'] = 0;
                mWorkerPool[i] = worker;
            }
            worker.postMessage({
                cmd: 'config',
                N: N,
                r: r,
            });
        }
    }

    export function hash(passBin: Uint8Array, saltBin: Uint8Array, dkLen: number) {
        mAsmU8.set(passBin, mPassPtr);
        mAsmU8.set(saltBin, mSaltPtr);

        mPassLen = passBin.length;
        mSaltLen = saltBin.length;
        mDkLen = dkLen || maxDkLen;

        mDoingCounter = 0;
        mDoneCounter = 0;

        // [B0, B1, ..., Bp] <- PBKDF2(pass, salt)
        mAsmObj._PBKDF2_OneIter(
            mPassPtr, mPassLen,
            mSaltPtr, mSaltLen,
            mBlksPtr, mBlkLen * mArgP
        );

        for (let i = 0; i < mThreads; i++) {
            task(mWorkerPool[i]);
        }
    }

    export function free() {
        mWorkerPool.forEach(w => {
            w.postMessage({
                cmd: 'free'
            });
        });
    }

    export function unload() {
        mWorkerPool.forEach(w => {
            w.terminate();
        });
        mWorkerPool = [];
        mAsmBuf = mAsmU8 = mAsmMod = null;
        URL.revokeObjectURL(mWorkerUrl);
    }

    function createWorkerUrl() {
        /**
         CODE GEN：
           (function Child(..) {
              ...
           })();
           function asm_smix() {
              ...
           }
         */
        let code = '(' + Child + ')();' + asm_smix;

        let blob = new Blob([code], {
            type: 'text/javascript'
        });

        return URL.createObjectURL(blob);
    }

    function complete() {
        // final hash
        mAsmObj._PBKDF2_OneIter(
            mPassPtr, mPassLen,
            mBlksPtr, mBlkLen * mArgP,
            mDkPtr, mDkLen > 32 ? mDkLen : 32
        );

        // pass reference
        let dkBin = new Uint8Array(mAsmBuf, mDkPtr, mDkLen);
        oncomplete(dkBin);
    }

    function msgHander(e: MessageEvent) {
        let worker: Worker = this;
        let msg = e.data;

        // fast case
        if (typeof msg == 'number') {
            worker.postMessage(true);
            return;
        }

        switch (msg.state) {
        case 'done':
            // Bi -> B'i
            let buf = new Uint8Array(msg.output);
            let id = worker['tag'];
            mAsmU8.set(buf, mBlksPtr + mBlkLen * id);

            if (++mDoneCounter == mArgP) {
                complete();
            } else if (mDoingCounter < mArgP) {
                task(worker);
            }
            break;

        case 'ready':
            if (++mReadyCounter == mThreads) {
                onready();
            }
            break;

        case 'fail':
            onerror('memory alloc fail');
            break;
        }
    }

    function task(worker: Worker) {
        let ptrBi = mBlksPtr + mDoingCounter * mBlkLen;
        let bufBi = mAsmBuf.slice(ptrBi, ptrBi + mBlkLen);

        worker['tag'] = mDoingCounter++;
        worker.postMessage({
            cmd: 'task',
            input: bufBi,
        }, [bufBi]); // no copy
    }
}
