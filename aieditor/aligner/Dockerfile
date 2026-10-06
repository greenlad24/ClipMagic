FROM python:3.11-slim
RUN pip install --no-cache-dir torch==2.5.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cpu && pip install --no-cache-dir numpy soundfile
ENV TORCH_HOME=/models
WORKDIR /work
