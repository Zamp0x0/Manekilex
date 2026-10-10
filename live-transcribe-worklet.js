/**
 * AudioWorklet：输出 mono Float32 原始采样，降采样与 PCM 转换由 live-transcribe.js 主线程完成。
 */
class LiveTranscribePcmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel?.length) return true;

    const copy = new Float32Array(channel.length);
    copy.set(channel);
    this.port.postMessage({ samples: copy.buffer, inputRate: sampleRate }, [copy.buffer]);
    return true;
  }
}

registerProcessor("live-transcribe-pcm-processor", LiveTranscribePcmProcessor);
