FROM golang:1.25-alpine AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/model-proxy .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -S app \
    && adduser -S app -G app
WORKDIR /app
COPY --from=builder /out/model-proxy /app/model-proxy
COPY config.example.yaml /app/config.yaml
COPY models.example.json /app/models.json
USER app
EXPOSE 8080
ENTRYPOINT ["/app/model-proxy", "-f", "/app/config.yaml"]
