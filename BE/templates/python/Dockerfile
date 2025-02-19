FROM python:3.9-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt ./
RUN pip install -r requirements.txt

# Copy function code
COPY index.py ./

# Add wrapper script
COPY wrapper.py ./

EXPOSE 8080

CMD ["python", "wrapper.py"]
