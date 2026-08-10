FROM golang:1.24-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=0.1.1
RUN CGO_ENABLED=0 GOOS=linux go build \
    -trimpath -ldflags="-s -w -X main.version=${VERSION}" \
    -o beamit ./cmd/beamit/

FROM alpine:3.19
RUN apk --no-cache add ca-certificates
WORKDIR /app
COPY --from=builder /app/beamit .

EXPOSE 8080
EXPOSE 3478/udp

ENTRYPOINT ["./beamit"]
