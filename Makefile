.PHONY: build run dev test clean docker

BINARY_NAME=beamit
VERSION=$(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
BUILD_TIME=$(shell date -u +"%Y-%m-%dT%H:%M:%SZ")
LDFLAGS=-ldflags "-s -w -X main.version=$(VERSION) -X main.buildTime=$(BUILD_TIME)"

build:
	CGO_ENABLED=0 go build $(LDFLAGS) -o $(BINARY_NAME) ./cmd/beamit/

run: build
	./$(BINARY_NAME)

dev:
	go run ./cmd/beamit/ --dev

test:
	go test -v -race -count=1 ./...

test-cover:
	go test -v -race -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out -o coverage.html

clean:
	rm -f $(BINARY_NAME) coverage.out coverage.html

docker:
	docker build -t beamit:$(VERSION) .

lint:
	golangci-lint run ./...

# Cross-compilation
build-all: build-linux build-darwin build-windows

build-linux:
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build $(LDFLAGS) -o $(BINARY_NAME)-linux-amd64 ./cmd/beamit/
	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build $(LDFLAGS) -o $(BINARY_NAME)-linux-arm64 ./cmd/beamit/

build-darwin:
	GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 go build $(LDFLAGS) -o $(BINARY_NAME)-darwin-amd64 ./cmd/beamit/
	GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build $(LDFLAGS) -o $(BINARY_NAME)-darwin-arm64 ./cmd/beamit/

build-windows:
	GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build $(LDFLAGS) -o $(BINARY_NAME)-windows-amd64.exe ./cmd/beamit/
