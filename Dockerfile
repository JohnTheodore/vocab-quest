FROM python:3.12-slim

# Install only the new google-genai package (NOT google-generativeai)
RUN pip install --no-cache-dir google-genai pillow

WORKDIR /app
COPY generate_images.py .

WORKDIR /data
ENTRYPOINT ["python", "/app/generate_images.py"]
