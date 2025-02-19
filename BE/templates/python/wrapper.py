from flask import Flask, request, jsonify
import time
import json
import traceback
import psutil
import importlib.util
import sys

app = Flask(__name__)

# Import user function
spec = importlib.util.spec_from_file_location("user_function", "./index.py")
user_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(user_module)
handler = user_module.handler

@app.route('/health')
def health():
    return jsonify({'status': 'healthy'})

@app.route('/invoke', methods=['POST'])
def invoke():
    start_time = time.time()
    
    try:
        event = request.get_json()
        result = handler(event)
        duration = (time.time() - start_time) * 1000  # Convert to milliseconds
        
        # Log metrics
        print(json.dumps({
            'timestamp': time.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
            'type': 'metric',
            'name': 'function_duration',
            'value': duration,
            'unit': 'ms'
        }))
        
        return jsonify({
            'result': result,
            'duration': duration,
            'memory': psutil.Process().memory_info().rss
        })
        
    except Exception as e:
        print(json.dumps({
            'timestamp': time.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
            'type': 'error',
            'message': str(e),
            'stack': traceback.format_exc()
        }))
        
        return jsonify({
            'error': str(e),
            'stack': traceback.format_exc() if app.debug else None
        }), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080)
