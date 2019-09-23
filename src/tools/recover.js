const Queue = require('../libs/queue');

(async function() {

    let [ socketQ, workerQ ] = await init(false, true);

    await testRecover(socketQ, workerQ);

    console.log('Complete.');
    process.exit();
})();

async function init(worker, sockets) {
    global.l = function(){};
    global.l.info = global.l.trace = global.l.error = global.l.debug = (...args)=>{
        // we don't need this output
    };

    let conf = {
        data: {
            'queue.amqp_host': 'amqp://127.0.0.1',
            'queue.sockets_queue': 'q_sockets',
            'queue.worker_queue': 'q_worker',
        },
        get(name) {
            return this.data[name];
        },
    };

    let workerQ = new Queue(conf);
    let socketQ = new Queue(conf);

    try {
        worker && await workerQ.connect();
        sockets && await socketQ.connect();

        worker && workerQ.listenForEvents();
        sockets && socketQ.listenForEvents();
    } catch (err) {
        console.error(`Error connecting to the queue: ${err.message}`);
        process.exit(1);
    }

    return [ socketQ, workerQ ];
}

async function testRecover(socketQ, workerQ) {
    function sleep(len) {
        return new Promise(r => {
            setTimeout(r, len);
        });
    }

    let cnt = 1;
    while(1) {
        await socketQ.sendToWorker('myevent', {
            num: String(cnt)
        });
        await sleep(100);
        cnt++;
    }
}
