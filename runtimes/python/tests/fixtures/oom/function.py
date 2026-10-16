def handler(event, context):
    hoard = []
    while True:
        hoard.append(bytearray(8 * 1024 * 1024))
