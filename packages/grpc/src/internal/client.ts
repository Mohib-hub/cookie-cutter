/*
Copyright (c) Walmart Inc.

This source code is licensed under the Apache 2.0 license found in the
LICENSE file in the root directory of this source tree.
*/

import {
    AsyncPipe,
    DefaultComponentContext,
    failSpan,
    IComponentContext,
    IDisposable,
    IMetrics,
    IRequireInitialization,
    OpenTracingTagKeys,
} from "@walmartlabs/cookie-cutter-core";
import {
    CallOptions,
    Client,
    ClientReadableStream,
    credentials,
    makeGenericClientConstructor,
    Metadata,
    MethodDefinition,
} from "grpc";
import { FORMAT_HTTP_HEADERS, Span, SpanContext, Tags, Tracer } from "opentracing";
import { performance } from "perf_hooks";
import { createGrpcConfiguration, createServiceDefinition } from ".";
import { IGrpcClientConfiguration, IGrpcConfiguration } from "..";

enum GrpcMetrics {
    RequestSent = "cookie_cutter.grpc_client.request_sent",
    RequestProcessed = "cookie_cutter.grpc_client.request_processed",
    RequestProcessingTime = "cookie_cutter.grpc_client.request_processing_time",
}
enum GrpcMetricResult {
    Success = "success",
    Error = "error",
}

class ClientBase implements IRequireInitialization, IDisposable {
    private pendingStreams: Set<ClientReadableStream<any>>;
    public tracer: Tracer;
    public metrics: IMetrics;

    constructor(private readonly client: Client) {
        this.pendingStreams = new Set();
        this.tracer = DefaultComponentContext.tracer;
        this.metrics = DefaultComponentContext.metrics;
    }

    public async initialize(context: IComponentContext): Promise<void> {
        this.tracer = context.tracer;
        this.metrics = context.metrics;
    }

    public async dispose(): Promise<void> {
        for (const item of this.pendingStreams.values()) {
            item.cancel();
        }
        this.client.close();
    }

    public addStream(stream: ClientReadableStream<any>): void {
        this.pendingStreams.add(stream);
        stream.on("close", () => {
            this.pendingStreams.delete(stream);
        });
    }
}

export function createGrpcClient<T>(
    config: IGrpcClientConfiguration & IGrpcConfiguration
): T & IDisposable & IRequireInitialization {
    const serviceDef = createServiceDefinition(config.definition);
    const ClientType = makeGenericClientConstructor(serviceDef, undefined, undefined);
    const client = new ClientType(
        config.endpoint,
        credentials.createInsecure(),
        createGrpcConfiguration(config)
    );

    const wrapper: T & ClientBase = new ClientBase(client) as any;
    for (const key of Object.keys(serviceDef)) {
        const method = serviceDef[key];
        if (method.requestStream) {
            wrapper[key] = function() {
                throw new Error("client-side streams are not supported");
            };
            continue;
        }

        let ready = false;
        const whenReady = (span: Span) =>
            new Promise((resolve, reject) => {
                client.waitForReady(Date.now() + config.connectionTimeout!, (err) => {
                    if (err) {
                        failSpan(span, err);
                        span.finish();
                        reject(err);
                    } else {
                        ready = true;
                        resolve();
                    }
                });
            });

        const callOptions = (): CallOptions => {
            const deadline = method.responseStream
                ? undefined // streams may run infinitely
                : Date.now() + config.requestTimeout!;

            return {
                deadline,
                credentials: undefined,
                propagate_flags: undefined,
            };
        };

        if (method.responseStream) {
            wrapper[key] = async function*(
                request: any,
                spanContext: SpanContext
            ): AsyncIterableIterator<any> {
                const startTime = performance.now();
                this.metrics.increment(GrpcMetrics.RequestSent, {
                    path: method.path,
                    endpoint: config.endpoint,
                });
                const span = createCallSpan(wrapper.tracer, config.endpoint, method, spanContext);
                if (!ready) {
                    await whenReady(span);
                }

                const stream = client.makeServerStreamRequest(
                    method.path,
                    method.requestSerialize,
                    method.responseDeserialize,
                    request,
                    createTracingMetadata(wrapper.tracer, span),
                    callOptions()
                );

                const pipe = new AsyncPipe<any>();
                stream.on("end", async () => {
                    await pipe.close();
                    wrapper.metrics.increment(GrpcMetrics.RequestProcessed, {
                        path: method.path,
                        result: GrpcMetricResult.Success,
                        endpoint: config.endpoint,
                    });
                    emitTimerMetric(startTime, method.path, config.endpoint, wrapper.metrics);
                    span.finish();
                });

                stream.on("error", async (error) => {
                    wrapper.metrics.increment(GrpcMetrics.RequestProcessed, {
                        path: method.path,
                        result: GrpcMetricResult.Error,
                        endpoint: config.endpoint,
                    });
                    emitTimerMetric(startTime, method.path, config.endpoint, wrapper.metrics);
                    failSpan(span, error);
                    span.finish();
                    await pipe.throw(error);
                });

                stream.on("data", async (chunk) => {
                    try {
                        await pipe.send(chunk);
                    } catch (e) {
                        // nothing to do, pipe was closed
                    }
                });

                wrapper.addStream(stream);
                yield* pipe;
            };
        } else {
            wrapper[key] = async function(request: any, spanContext: SpanContext): Promise<any> {
                const startTime = performance.now();
                this.metrics.increment(GrpcMetrics.RequestSent, {
                    path: method.path,
                    endpoint: config.endpoint,
                });
                const span = createCallSpan(wrapper.tracer, config.endpoint, method, spanContext);
                if (!ready) {
                    await whenReady(span);
                }

                return await new Promise((resolve, reject) => {
                    client.makeUnaryRequest(
                        method.path,
                        method.requestSerialize,
                        method.responseDeserialize,
                        request,
                        createTracingMetadata(wrapper.tracer, span),
                        callOptions(),
                        (error, value) => {
                            this.metrics.increment(GrpcMetrics.RequestProcessed, {
                                path: method.path,
                                endpoint: config.endpoint,
                                result: error ? GrpcMetricResult.Error : GrpcMetricResult.Success,
                            });
                            emitTimerMetric(
                                startTime,
                                method.path,
                                config.endpoint,
                                wrapper.metrics
                            );
                            if (error) {
                                failSpan(span, error);
                                span.finish();
                                reject(error);
                            } else {
                                span.finish();
                                resolve(value);
                            }
                        }
                    );
                });
            };
        }
    }

    return wrapper;
}

function createCallSpan(
    tracer: Tracer,
    host: string,
    method: MethodDefinition<any, any>,
    spanContext: SpanContext
): Span {
    const span = tracer.startSpan("Grpc Client Call", { childOf: spanContext });
    span.setTag(Tags.SAMPLING_PRIORITY, 1);
    span.setTag(Tags.SPAN_KIND, Tags.SPAN_KIND_RPC_CLIENT);
    span.setTag(Tags.COMPONENT, "cookie-cutter-grpc");
    span.setTag(OpenTracingTagKeys.RpcCall, method.path);
    span.setTag(OpenTracingTagKeys.RpcHost, host);
    span.setTag(OpenTracingTagKeys.RpcFlavor, "grpc");

    return span;
}

function createTracingMetadata(tracer: Tracer, span: Span): Metadata {
    const metadata = new Metadata();
    const carrier: { [name: string]: string } = {};
    tracer.inject(span, FORMAT_HTTP_HEADERS, carrier);
    for (const [name, value] of Object.entries(carrier)) {
        metadata.set(name, value);
    }

    return metadata;
}

function emitTimerMetric(
    startTime: number,
    path: string,
    endpoint: string,
    metrics: IMetrics
): void {
    const currentPerformanceTime = performance.now();
    const runTime = Math.round(currentPerformanceTime - startTime);
    metrics.timing(GrpcMetrics.RequestProcessingTime, runTime, {
        path,
        endpoint,
    });
}
