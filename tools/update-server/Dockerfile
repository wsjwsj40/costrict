FROM golang:1.23-alpine AS builder
WORKDIR /src
COPY go.mod ./
COPY main.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/dicode-update-server .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /out/dicode-update-server /usr/local/bin/dicode-update-server
ENV UPDATE_SERVER_CONFIG_DIR=/config
ENV UPDATE_SERVER_RELEASES_DIR=/releases
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/dicode-update-server"]
