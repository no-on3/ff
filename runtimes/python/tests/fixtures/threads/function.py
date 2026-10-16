import threading


def handler(event, context):
    # Ten threads at once, like boto3's S3 transfer pool.
    sizes = []
    lock = threading.Lock()

    def work():
        data = bytearray(1024 * 1024)
        with lock:
            sizes.append(len(data))

    threads = [threading.Thread(target=work) for _ in range(10)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return {"threads": len(sizes), "stackSize": threading.stack_size()}
