FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum main.go token_service.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/dicode-codex-bridge .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates && addgroup -S app && adduser -S app -G app
COPY --from=build /out/dicode-codex-bridge /app/dicode-codex-bridge
USER app
EXPOSE 8080
ENTRYPOINT ["/app/dicode-codex-bridge"]
